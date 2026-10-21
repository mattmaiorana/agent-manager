// The workspace, the plugin's side: the browser leaf, live status dots, the dedicated terminal split, routing, and open sessions.

import { import_obsidian } from "../externals.js";
import { BrowserView } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { SessionController } from "../sessions/controller.js";
import { SessionSwitcherModal } from "../ui/modals.js";
var WorkspaceMethods = class {
  // Every browser leaf, a deferred one included: its type is known before its view
  // loads (missing a deferred leaf once spawned a stray second sidebar).
  _browserLeaves() {
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
  }
  // The browsers whose view has loaded, for anything that renders into one.
  browserViews() {
    return this._browserLeaves().map((l) => l.view).filter((v) => v instanceof BrowserView);
  }
  // ---- Session tabs ----
  // A session is a controller on a view of the terminal (sessions/controller.js).
  // Everything that looks for sessions goes through these.
  // Every session tab's leaf, deferred ones included.
  sessionLeaves() {
    const ws = this.app.workspace;
    return ws.getLeavesOfType(SESSION_VIEW_TYPE);
  }
  // The session behind a leaf, a view, or a controller; null for anything else, and for
  // a tab Obsidian hasn't loaded yet.
  sessionOf(x) {
    if (!x) return null;
    if (x instanceof SessionController) return x;
    const v = x instanceof import_obsidian.WorkspaceLeaf ? x.view : x;
    if (v && v.controller instanceof SessionController) return v.controller;
    return null;
  }
  // Every loaded session.
  sessionObjects() {
    return this.sessionLeaves().map((l) => this.sessionOf(l)).filter(Boolean);
  }
  // Is this a session view (or its controller)?
  isSessionView(v) {
    return !!this.sessionOf(v);
  }
  // A session tab's saved fields, loaded or not, kept under its view state's `host` key.
  // Null for a leaf that isn't a session tab.
  savedSessionState(leaf) {
    let vs;
    try { vs = leaf.getViewState?.(); } catch { return null; }
    if (!vs) return null;
    if (vs.type === SESSION_VIEW_TYPE) return (vs.state && vs.state.host) || {};
    return null;
  }
  // Change a tab's saved fields (one Obsidian hasn't loaded yet). `change` edits them in
  // place and returns true to save.
  async updateSavedSession(leaf, change) {
    const vs = leaf.getViewState?.();
    if (!vs) return;
    let fields = null;
    if (vs.type === SESSION_VIEW_TYPE) { vs.state = vs.state || {}; fields = vs.state.host = vs.state.host || {}; }
    if (!fields || !change(fields)) return;
    await leaf.setViewState(vs);
    this.app.workspace.requestSaveLayout();
  }
  findBrowserLeaf() {
    return this._browserLeaves()[0] || null;
  }
  // Backstop for the reload race: if more than one browser leaf slipped through,
  // keep one (the passed keeper if still valid, else the first) and detach the rest.
  dedupeBrowserLeaves(keeper) {
    const browsers = this._browserLeaves();
    if (browsers.length < 2) return;
    const keep = keeper && browsers.includes(keeper) ? keeper : browsers[0];
    for (const l of browsers) if (l !== keep) { try { l.detach(); } catch { /* best effort */ } }
  }
  // Open a new empty-state browser leaf (agent list).
  async createBrowserTab() {
    if (!this.layoutReady) return;
    // Re-check for an existing browser right before creating one. The resume deep
    // link can call in during reload before Obsidian has instantiated the persisted
    // browser leaf, whose view is still deferred — a plain instanceof check misses
    // it and we'd spawn a second browser in another dock. findBrowserLeaf matches the persisted state too, so the restoring
    // leaf is found and reused.
    const existing = this.findBrowserLeaf();
    if (existing) { this.app.workspace.revealLeaf(existing); return; }
    // In-flight guard: two concurrent calls (a double-fired protocol link) can't
    // both pass the check above and double-create.
    if (this._browserCreateInFlight) return;
    this._browserCreateInFlight = true;
    try {
      // Born in the LEFT dock, beside the file tree, so a fresh browser matches the
      // intended layout (agent list as a persistent left column). Once created,
      // Obsidian persists wherever it's dragged, so this is just the first-run/
      // re-create default.
      const leaf = this.app.workspace.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: BROWSER_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      // Belt-and-suspenders: if a persisted leaf restored while we were creating,
      // drop the duplicate and keep the one we just opened.
      this.dedupeBrowserLeaves(leaf);
    } finally {
      this._browserCreateInFlight = false;
    }
  }
  // Single instance: reveal the existing browser leaf if there is one (Obsidian
  // restores it in its last sidebar spot across reloads), otherwise open one.
  // The ribbon and open commands route here so repeated clicks don't pile up.
  async revealBrowser() {
    if (!this.layoutReady) return;
    // State-aware match so a browser leaf still restoring (deferred view) on reload
    // is found and reused, not duplicated.
    const existing = this.findBrowserLeaf();
    if (existing) {
      // Clicking the icon while the browser is already active drops back to the
      // agent list (a second way to go "home" besides the "‹ name" chevron).
      // Guard on instanceof: a deferred leaf has no BrowserView yet, so just reveal
      // it (revealLeaf instantiates it).
      if (existing.view instanceof BrowserView
          && this.app.workspace.activeLeaf === existing && existing.view.browserScope) {
        try { existing.view.goHome(); } catch { /* best effort */ }
      }
      this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.createBrowserTab();
  }
  async openSessionSwitcher() {
    let sessions = [];
    try { sessions = await this.listedSessions(); } catch { /* best effort */ }
    new SessionSwitcherModal(this.app, this, sessions).open();
  }
  // Re-render every open browser leaf. Used after a session's open state changes
  // with no browser click to drive it (resume-on-reload, or resuming into a tab):
  // a full render is needed, not just refreshStatusDots, because the home page's
  // "Open sessions" section lists only currently-open sessions — an in-place dot
  // toggle can't add or remove that section (or the session's row within it). It
  // also flips the green dot on the session-page list.
  refreshBrowsers() {
    for (const v of this.browserViews()) {
      v.reresolveScope().catch(() => {}).then(() => {
        try { v.renderBrowser({ background: true }); } catch { /* best effort */ }
      });
    }
  }
  // Each open session's working state, polled on a timer (not focus-driven) so a
  // background session is followed too. Its working-to-idle edge drives the strip's
  // model badge, re-host detection, the durable transcript, and the note write-back.
  // The sidebar shows only whether a session is open; what it's doing shows on its tab.
  refreshWorkingDots() {
    const open = this.getOpenSessions();
    if (!open.length) return; // nothing open — a close already cleared the dots
    const working = open.filter((o) => this.sessionIsWorking(o.view));
    const workingKeys = new Set(working.map((o) => this.openSessionKey(o)));
    // Refresh each session's strip model badge on the working→idle edge (a turn just
    // completed, so a fresh model record was written) PLUS a ~30s staleness backstop.
    // The edge alone isn't enough: a /model switch mid-use
    // left a session's badge frozen on the old model for hours because no refreshing
    // edge fired for it. One 64KB tail-read per ~30s per open session is negligible.
    const nowMs = Date.now();
    for (const o of open) {
      const v = o.view;
      if (!v) continue;
      const isW = working.includes(o);
      // Seen working ⇒ a real, initialized session (backstop to the trust-gate flag
      // set in sendAgentOpening, covering resume and any non-nudge launch path).
      if (isW) v._sessionInteractive = true;
      const edge = v._wasWorking && !isW;
      // Follow a bridge re-host on each completed turn: if the live conversation moved to
      // a new session id (an RC re-host), repoint this view to it. On a repoint it
      // clears _durableCaughtUp, so the next tick's catch-up captures the re-host.
      if (edge) v._detectRehostedSession?.().catch(() => {});
      const stale = nowMs - (v._modelRefreshedAt || 0) > 30000;
      if (edge || stale) {
        v._modelRefreshedAt = nowMs;
        try { v.updateStripModel(); } catch { /* best effort */ }
      }
      // A completed turn just wrote fresh records — accumulate them into the
      // durable transcript. Also fire once per session as a catch-up (a resumed
      // idle session that never takes another turn still gets captured).
      // Durable capture: on the edge (a turn just completed), on the one-time catch-up,
      // and — the safety net — whenever the transcript file has GROWN since the last
      // reconcile, checked by a stat every ~30s. Growth is the thing that actually
      // matters; the working→idle edge is only a proxy for it, and a heuristic one (a
      // bg-attached or crashed-and-resumed session can miss an edge). A stat is ~20µs,
      // so the check costs nothing, and the expensive full-file reconcile runs only
      // when new records really landed. The re-host detector above fixes WHICH file;
      // this fixes WHEN.
      let grew = false;
      if (nowMs - (v._durableCheckedAt || 0) > 30000) {
        v._durableCheckedAt = nowMs;
        grew = !!v.transcriptGrewSinceReconcile?.();
      }
      // One reconcile per tick: the note write-back below takes this one's result.
      let written = null;
      if (edge || !v._durableCaughtUp || grew) {
        written = v.updateDurableTranscript?.() || null;
        // Caught up only once there's a file to catch up with; until then, every tick tries.
        v._durableCaughtUp = !!v._modelFile;
      }
      // The note write-back: on each completed turn, and every few seconds until the link
      // is written, so a fresh Codex or Antigravity session's link lands as soon as its
      // transcript appears rather than on its next turn.
      if (v._notePath && !v._noteWritten && (edge || nowMs - (v._noteTriedAt || 0) > 3000)) {
        v._noteTriedAt = nowMs;
        v.maybeWriteNoteBack?.(written);
      }
      v._wasWorking = isW;
    }
    // The first time a session is seen working, its transcript is being written, so
    // its list row can upgrade from the id-less "just launched" row (from the open-
    // session fallback) to a real, pinnable one. Fire a one-time browser re-render a
    // beat later, once the transcript has flushed. Fixes: pin/rename missing on a
    // freshly-started session until you leave the leaf and come back.
    this._seenWorking = this._seenWorking || new Set();
    for (const key of workingKeys) {
      if (this._seenWorking.has(key)) continue;
      this._seenWorking.add(key);
      // Only a browser showing a row with no id yet has anything to upgrade.
      this.scheduleTimeout(() => {
        for (const v of this.browserViews()) {
          if (v.containerEl.querySelector('.agent-manager-session-row[data-session-id=""]')) { try { v.renderBrowser({ background: true }); } catch { /* best effort */ } }
        }
      }, 1500);
    }
    for (const view of this.browserViews()) {
      try { view.refreshTodayDot(); } catch { /* best effort */ }
    }
  }
  // Is this session's CLI actively producing? Three layers, cheapest first.
  //
  // Pure footer-scraping (the old approach) is fragile: it misses whole working
  // states that show no spinner line at all (a background-agent wait, a plan-wait),
  // it breaks whenever a CLI rewords its footer, and the spinner line gets pushed
  // out of any fixed window by a multi-line input box or an open autocomplete menu.
  // So the scrape is now the PRECISION layer over an output-ACTIVITY recall layer:
  // a working CLI repaints continuously (spinner animation, streaming text), an idle
  // one goes silent for minutes.
  //
  //   1. Idle fast path. No real output in ~2s → not working. Most sessions are idle
  //      most of the time, and this costs one subtraction and zero buffer reads.
  //   2. Claude title accelerator. A leading spinner glyph in the cached terminal
  //      title (see the onTitleChange handler) is an instant, typing-proof "working"
  //      signal that holds for the whole turn. Claude only; other CLIs fall through.
  //   3. Scrape (precision). The CLI's own footer markers, authoritative and immune
  //      to the user typing (typing is never a spinner line): "esc to interrupt"
  //      (Claude at turn start; Codex) / "esc to cancel" (Antigravity), or Claude's
  //      live-spinner line — a "…" gerund ellipsis then a parenthesized elapsed timer
  //      ("(3s)" / "(1m 57s · …)"). The done summary ("✻ Crunched for 2m 23s") and
  //      the idle prompt have neither. 12-row window, since the spinner sits above
  //      the input box and its chrome.
  //   4. Activity fallback (recall). Output is flowing but no marker matched (an
  //      unrecognized/reworded footer, a background-agent wait, or the spinner pushed
  //      out of the window). Trust it as working UNLESS the flow is just the CLI
  //      echoing the user's own typing.
  sessionIsWorking(view) {
    const now = Date.now();
    // Claude in the new terminal says so itself, through its hooks: trusted while it
    // reports. Its title glyph and the scrape below cover a start without the hooks
    // (an attach, a retry without the terminal's additions).
    const said = view?.programState;
    if (view?.getBackendKey?.() === "claude" && (said === "working" || said === "waiting" || said === "idle" || said === "finished" || said === "error")) return said === "working";
    // 1. Idle fast path. (Kept first so a stale glyph title on a dead CLI can't pin
    //    the dot on — a working session is still emitting its animated footer.)
    if (now - (view?.lastWorkOutputAt || 0) > 2000) return false;
    // 2. Claude title accelerator: leading spinner glyph (moon/star/braille families,
    //    U+2000–U+2BFF). Idle titles start with a letter or path, so they can't match.
    if (/^[\u2000-\u2bff]/.test(view?._lastTitle || "")) return true;
    // 3. Scrape (precision): the screen's last 12 rows.
    const rows = view?._terminalTailText ? view._terminalTailText(12).split("\n") : [];
    for (const raw of rows) {
      const line = raw.toLowerCase();
      if (line.includes("esc to interrupt") || line.includes("esc to cancel")) return true;
      if (/…\s*\(\d+m?\s*\d*s[\s·)]/.test(raw)) return true;
    }
    // 4. Activity fallback: producing, and not merely echoing recent keystrokes.
    return now - (view?.lastUserInputAt || 0) > 1500;
  }
  // A cheap fingerprint of the set of open (backend, title) sessions. Used to skip
  // a refresh when nothing actually opened or closed — so incidental layout events
  // (resize, move, a focus-click that opens nothing) don't churn or swallow clicks.
  openSetSignature() {
    return [...this.getOpenSessionKeys()].sort().join("|");
  }
  // The single, reactive way the browser's open/closed display stays in sync.
  // Debounced to coalesce bursts, and gated on openSetSignature so it re-renders
  // only when the open set truly changed. Called from every event that can change
  // that set: a session's process spawning (launch/resume) or exiting, and any
  // layout change (a tab closing is the important one). renderBrowser (not just
  // refreshStatusDots) so the home page's "Open sessions" section adds/removes
  // rows, not only toggles dots.
  scheduleStatusRefresh() {
    if (this._statusRefreshTimer) return;
    this._statusRefreshTimer = this.scheduleTimeout(() => {
      this._statusRefreshTimer = null;
      const sig = this.openSetSignature();
      if (sig === this._lastOpenSig) return;
      this._lastOpenSig = sig;
      this.refreshBrowsers();
    }, 60);
  }
  // --- Dedicated terminal split (Phase 1) --------------------------------
  // Session terminals get their own main-area tab group on the right, so they never
  // interleave with notes (which stay on the left), unless the setting is off.
  useDedicatedSplit() {
    return this.pluginData.dedicatedTerminalSplit !== false;
  }
  // True when a leaf/node lives in the main editor area (rootSplit), not a dock.
  isInMainArea(node) {
    const root = this.app.workspace.rootSplit;
    for (let n = node; n; n = n.parent) if (n === root) return true;
    return false;
  }
  // The main-area tab group holding session terminals, if the split exists: the group
  // of any session leaf in the main area.
  getTerminalGroup() {
    for (const leaf of this.sessionLeaves()) {
      if (leaf.parent?.type === "tabs" && this.isInMainArea(leaf)) return leaf.parent;
    }
    return null;
  }
  // A main-area non-terminal leaf to anchor the split off / open notes into. Prefer
  // the most-recent such leaf; fall back to any main-area non-terminal leaf.
  getNotesAnchorLeaf() {
    const ws = this.app.workspace;
    const recent = ws.getMostRecentLeaf();
    const isOurs = (v) => this.isSessionView(v) || v instanceof BrowserView || v?.getViewType?.() === SESSION_VIEW_TYPE;
    if (recent && this.isInMainArea(recent) && !isOurs(recent.view)) return recent;
    let fallback = null;
    ws.iterateAllLeaves((leaf) => {
      if (fallback) return;
      if (this.isInMainArea(leaf) && !isOurs(leaf.view)) fallback = leaf;
    });
    return fallback;
  }
  // A fresh leaf in the dedicated terminal group, creating the group (a right-side
  // split) on first use. Falls back to a plain tab when the split isn't in play.
  openTerminalLeaf() {
    const ws = this.app.workspace;
    if (!this.useDedicatedSplit()) return ws.getLeaf("tab");
    const group = this.getTerminalGroup();
    if (group) return ws.createLeafInParent(group, group.children.length);
    const anchor = this.getNotesAnchorLeaf();
    if (anchor) return ws.createLeafBySplit(anchor, "vertical", false); // new group on the RIGHT
    return ws.getLeaf("tab");
  }
  // The main-area 'tabs' group that is NOT the terminal group (the notes side), or null.
  getNotesGroup() {
    const ws = this.app.workspace;
    const termGroup = this.getTerminalGroup();
    let found = null;
    ws.iterateAllLeaves((leaf) => {
      if (found) return;
      if (!this.isInMainArea(leaf) || leaf.parent?.type !== "tabs" || leaf.parent === termGroup) return;
      found = leaf.parent;
    });
    return found;
  }
  // Create a notes group to the LEFT of the terminal group and return its fresh leaf.
  createNotesGroupWithLeaf() {
    const group = this.getTerminalGroup();
    const anchor = group?.children?.[0]; // a terminal leaf to split off
    if (!anchor) return this.app.workspace.getLeaf("tab");
    return this.app.workspace.createLeafBySplit(anchor, "vertical", true); // new group on the LEFT
  }
  // The leaf a routed note open should land in: reuse the visible, navigable notes
  // leaf (in-place open, like normal single-pane nav); else a new tab in the notes
  // group (a pinned/hidden note); else create the notes group on the left.
  getOrCreateNotesLeaf() {
    const ws = this.app.workspace;
    const termGroup = this.getTerminalGroup();
    let visibleNav = null, anyNotesLeaf = null;
    ws.iterateAllLeaves((leaf) => {
      if (!this.isInMainArea(leaf) || leaf.parent?.type !== "tabs" || leaf.parent === termGroup) return;
      anyNotesLeaf = anyNotesLeaf || leaf;
      // offsetParent is null for a hidden background tab, so this picks the shown one.
      if (!visibleNav && leaf.canNavigate?.() && leaf.view?.containerEl?.offsetParent != null) visibleNav = leaf;
    });
    if (visibleNav) return visibleNav;
    if (anyNotesLeaf) return ws.createLeafInParent(anyNotesLeaf.parent, anyNotesLeaf.parent.children.length);
    return this.createNotesGroupWithLeaf();
  }
  // Layer 1: instance-wrap the two leak methods so a note open is routed to the notes
  // group before any leaf is made. Only installs when the originals are functions (else
  // a future Obsidian that renamed them would throw in the fast path and break ALL file
  // opening); on unload only removes our own wrapper (don't clobber a later patcher).
  installOpenRouting() {
    const ws = this.app.workspace;
    // What the wrappers need from the plugin, as arrows: the wrappers themselves are
    // plain functions, so `this` in them is the workspace they were called on.
    const terminalGroup = () => (this.useDedicatedSplit() ? this.getTerminalGroup() : null);
    const notesLeaf = () => this.getOrCreateNotesLeaf();
    const notesGroup = () => this.getNotesGroup();
    const newNotesGroup = () => this.createNotesGroupWithLeaf();
    const origUnpinned = ws.getUnpinnedLeaf;
    const origInTabGroup = ws.createLeafInTabGroup;
    if (typeof origUnpinned !== "function" || typeof origInTabGroup !== "function") {
      this._openRoutingAvailable = false;
      console.warn("[Agent Manager] open-routing: workspace internals not found; skipping (file-opening unaffected).");
      return;
    }
    this._openRoutingAvailable = true;
    const wrappedUnpinned = function (setActive) {
      let group = null;
      try { group = terminalGroup(); } catch { /* routing is best effort */ }
      if (!group) return origUnpinned.call(this, setActive);
      const before = group.children ? group.children.slice() : [];
      const leaf = origUnpinned.call(this, setActive);
      try {
        if (!leaf || leaf.parent !== group) return leaf; // landed on the notes side already
        const target = notesLeaf();
        if (!target) return leaf;
        if (setActive !== false) ws.setActiveLeaf(target);
        if (!before.includes(leaf)) leaf.detach(); // only the stray THIS call created
        return target;
      } catch (e) { console.error("[Agent Manager] open-routing (getUnpinnedLeaf)", e); return leaf; }
    };
    const wrappedInTabGroup = function (parent) {
      try {
        const group = terminalGroup();
        // An explicit parent is deliberate caller intent; never second-guess it.
        if (group && !parent && ws.getMostRecentLeaf()?.parent === group) {
          const notes = notesGroup();
          if (notes) return origInTabGroup.call(this, notes);
          const fresh = newNotesGroup();
          if (fresh) return fresh;
        }
      } catch (e) { console.error("[Agent Manager] open-routing (createLeafInTabGroup)", e); }
      return origInTabGroup.call(this, parent);
    };
    // On unload, put back exactly what was there: the workspace's own property when it
    // had one, else nothing, so the prototype's method shows through again.
    const ownUnpinned = Object.prototype.hasOwnProperty.call(ws, "getUnpinnedLeaf");
    const ownInTabGroup = Object.prototype.hasOwnProperty.call(ws, "createLeafInTabGroup");
    ws.getUnpinnedLeaf = wrappedUnpinned;
    ws.createLeafInTabGroup = wrappedInTabGroup;
    this.register(() => {
      if (ws.getUnpinnedLeaf === wrappedUnpinned) {
        if (ownUnpinned) ws.getUnpinnedLeaf = origUnpinned; else delete ws.getUnpinnedLeaf;
      }
      if (ws.createLeafInTabGroup === wrappedInTabGroup) {
        if (ownInTabGroup) ws.createLeafInTabGroup = origInTabGroup; else delete ws.createLeafInTabGroup;
      }
    });
  }
  // Layer 2: a debounced layout-change sweep that transplants any stray non-terminal
  // leaf out of the terminal group (drag-ins and anything the wrappers miss). State
  // transplant (getViewState/setViewState + history), not openFile, so it's deferred-
  // safe and view-type generic (moves a canvas/PDF/graph too).
  installTerminalGroupJanitor() {
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      if (this._sweepScheduled) return;
      this._sweepScheduled = true;
      this.scheduleTimeout(() => {
        this._sweepScheduled = false;
        try { this.sweepTerminalGroup(); } catch (e) { console.error("[Agent Manager] terminal-group sweep", e); }
      }, 150);
    }));
  }
  sweepTerminalGroup() {
    const ws = this.app.workspace;
    if (!ws.layoutReady || !this.useDedicatedSplit()) return;
    const group = this.getTerminalGroup();
    if (!group || !group.children) return;
    const strays = group.children.filter((leaf) => {
      const t = leaf.view?.getViewType?.();
      if (this._unmovableStrays?.has(leaf)) return false;
      return t && t !== SESSION_VIEW_TYPE && t !== "empty"; // leave empty "New tab" leaves alone
    });
    for (const stray of strays) {
      try {
        const notesGroup = this.getNotesGroup();
        const target = notesGroup
          ? ws.createLeafInParent(notesGroup, notesGroup.children.length)
          : this.createNotesGroupWithLeaf();
        if (!target) continue;
        const wasActive = ws.activeLeaf === stray;
        const state = stray.getViewState();
        target.setViewState(state).then(() => {
          try {
            if (stray.history && target.history) target.history.deserialize(stray.history.serialize());
            if (wasActive) ws.setActiveLeaf(target);
            stray.detach();
          } catch (e) { console.error("[Agent Manager] transplant finalize", e); }
        }).catch((e) => {
          // The note would not open in the new leaf. Drop the leaf, and leave this
          // stray where it is from now on instead of making a new leaf on every sweep.
          console.error("[Agent Manager] transplant", e);
          (this._unmovableStrays = this._unmovableStrays || new WeakSet()).add(stray);
          try { target.detach(); } catch { /* best effort */ }
        });
      } catch (e) { console.error("[Agent Manager] transplant", e); }
    }
  }
  // Open a fresh leaf and hand back its view, ready for a agent launch/resume.
  // where "tab" = a new main-area tab (routed into the terminal split when on);
  // "right" = the sidebar. The tab waits for the caller's launch or resume
  // (`awaitLaunch`, never saved), which builds its terminal.
  async openSessionLeaf(where = "tab") {
    if (!this.layoutReady) return null;
    const leaf = where === "right"
      ? this.app.workspace.getRightLeaf(false)
      : this.openTerminalLeaf();
    if (!leaf) return null;
    // The new terminal's view, its session waiting for the caller (sessions/controller.js).
    await leaf.setViewState({ type: SESSION_VIEW_TYPE, active: true, state: { host: { awaitLaunch: true } } });
    this.app.workspace.revealLeaf(leaf);
    for (let i = 0; i < 60; i++) {
      if (this.sessionOf(leaf)) break;
      await new Promise((r) => window.setTimeout(r, 20));
    }
    return this.sessionOf(leaf);
  }
  // The open sessions. Two CLIs can each hold a session of the same title, so
  // anything acting on one session matches its backend too, and its id once known.
  getOpenSessions() {
    const out = [];
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
  // A row for an open session whose transcript isn't readable yet.
  openSessionRecord(o) {
    return { title: o.title, displayName: o.title, backend: o.backendKey, sessionId: o.sessionId || null, mtime: Date.now(), file: null, cwd: null, listed: true };
  }
  // Matching a session row to an open tab: by id once the tab knows its id, by (backend,
  // title) only until it does. Two same-title tabs (a compaction continuation beside its
  // parent) are two sessions, not one row.
  openSessionKey(o) {
    return o.sessionId ? `${o.backendKey}\nid:${o.sessionId}` : `${o.backendKey}\n${o.title}`;
  }
  // The key a row answers to: its id once it has one, else its backend and title (a
  // fresh launch's own row, before its id is known). A row with an id never matches a
  // tab by name, so a new "Untitled" doesn't light up an old one.
  sessionRowKeys(backend, title, sessionId) {
    return sessionId ? [`${backend}\nid:${sessionId}`] : [`${backend}\n${title}`];
  }
  // Every session with a tab, for the sidebar's dots: the running ones, and a tab
  // restored on reload that Obsidian hasn't loaded yet (it loads on first view), from
  // what it saved, so its dot is green as long as its tab is in the tab bar.
  getOpenSessionKeys() {
    const set = new Set();
    for (const o of this.getOpenSessions()) set.add(this.openSessionKey(o));
    for (const leaf of this.sessionLeaves()) {
      if (this.sessionOf(leaf)) continue;
      const s = this.savedSessionState(leaf);
      if (s && s.sessionTitle && s.backendKey) set.add(this.openSessionKey({ title: s.sessionTitle, backendKey: s.backendKey, sessionId: s.sessionId || null }));
    }
    return set;
  }
  // The (backendKey, title) of the currently focused session tab, or null when the
  // focus isn't on a live session (a note, the browser sidebar). Same key format as getOpenSessionKeys, so the browser can mark
  // just that one row active and clear it when focus moves away.
  getActiveSessionKey() {
    const leaf = this.app.workspace.activeLeaf;
    const v = this.sessionOf(leaf);
    if (v && v.running && v.sessionTitle) {
      return this.openSessionKey({ backendKey: v.activeBackendKey || v.getBackendKey(), title: v.sessionTitle, sessionId: v._stripSessionId?.() || v.resumeSessionId || null });
    }
    return null;
  }
  getLeafForSession(title, backendKey, sessionId = null) {
    // Match a session's tab by title+backend, INCLUDING one restored on reload that
    // Obsidian has deferred — a background tab isn't loaded until it's focused, and
    // until then `leaf.view` is a lightweight placeholder, not a session view, so the
    // live view has no sessionTitle. But the leaf's *persisted state* carries the
    // title/backend (verified: `leaf.getViewState().state`), and reading it doesn't
    // force the view to load. Matching the live view (or getOpenSessions, which needs
    // a running proc) missed deferred tabs, so clicking the session in the browser
    // spawned a SECOND tab of an already-open session. iterateAllLeaves + view state
    // catches both loaded and deferred tabs.
    let found = null;
    for (const leaf of this.sessionLeaves()) {
      if (found) break;
      const live = this.sessionOf(leaf);
      // A loaded tab answers for itself; a deferred one, from what it saved.
      const s = live ? { sessionTitle: live.sessionTitle, backendKey: live.backendKey || live.getBackendKey() } : this.savedSessionState(leaf) || {};
      if (!s.sessionTitle || s.sessionTitle !== title || s.backendKey !== backendKey) continue;
      // Same title and backend. A compaction continuation shares its parent's title, so
      // when the caller knows the session id, a LOADED tab that has resolved a DIFFERENT
      // id is not this session. A deferred tab, or a view with no id yet, still matches
      // on title: the persisted tab state carries no id.
      if (sessionId) {
        const vid = live ? live._ownSessionId() : (this.savedSessionState(leaf)?.sessionId || null);
        if (vid && vid !== sessionId) continue;
      }
      found = leaf;
    }
    return found;
  }
  // Force restored session tabs to load (and so resume) instead of waiting for
  // focus — the "Force load all sessions on restart" setting. Staggered so N sessions
  // don't spawn their CLIs all at once. `isDeferred` skips the already-loaded
  // foreground tab; guarding on loadIfDeferred keeps older Obsidian builds (no
  // deferred-view API) on the pre-feature lazy behaviour instead of throwing.
  eagerLoadSessions(leaves) {
    const deferred = (leaves || []).filter(
      (l) => l && l.isDeferred && typeof l.loadIfDeferred === "function"
    );
    const GAP = 500;
    deferred.forEach((leaf, i) => {
      this.scheduleTimeout(() => {
        try { leaf.loadIfDeferred(); }
        catch (e) { console.error("[Agent Manager] Eager session load failed:", e); }
      }, i * GAP);
    });
  }
};
export { WorkspaceMethods };
