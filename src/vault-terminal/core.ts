// The terminal itself, for a host plugin to load (host.ts, PORTING.md): its
// sessions, finding Python and the programs, the login shell's environment,
// starting terminals, links, notifications, the Dock badge, and the guards
// that ask before closing a busy one. Everything a host doesn't decide.

import { FileSystemAdapter, Modal, Notice, TFile, normalizePath, type App, type WorkspaceLeaf } from "obsidian";
import { homedir } from "os";
import { delimiter, isAbsolute, join, relative } from "path";
import { execFile } from "child_process";
import {
  NotFoundError,
  fallbackPath,
  findProgram,
  findPython,
  loginShell,
  mergePath,
  pathForScript,
  probeLoginEnv,
  programEnv,
  agentEnv,
  parseNames,
  splitCommand,
} from "./finder";
import type { HelperSession } from "./session";
import type { TerminalSettings } from "./settings";
import type { HostLaunch, VaultTerminalHost, VaultTerminalState } from "./host";
import { closeText, type CloseReason } from "./close";
import { TerminalView, makeTerminalView, noteAutomounts, type TerminalKind } from "./view";
import { zshIntegrationEnv } from "./zsh";
import { AGENTS, agentById, prepareAgent } from "./agents";

export type { CloseReason } from "./close";

export interface Launch {
  python: string;
  program: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** What the terminal added to an agent's command and environment, by name; empty for none. */
  added: string[];
  /** zsh's shell integration is in this launch. */
  integration: boolean;
}

/** How a terminal is started, besides what it runs. */
export interface LaunchOptions {
  /** Without the terminal's additions to an agent: its command and environment as the user has them. */
  plain?: boolean;
  /** A shell without shell integration. */
  noIntegration?: boolean;
  /** Told which step the start is on, for the line a slow start shows. */
  step?: (what: string) => void;
  /** What the host adds to an agent's command (host.ts, HostLaunch). */
  host?: HostLaunch;
}

/**
 * Self-test switches (dev builds only set them): each changes one thing,
 * to make a failure the self-test needs.
 */
export interface TestSwitches {
  /** The helper waits this long before starting the program. */
  helperDelay?: number;
  /** zsh's shell integration fails, and nothing else. */
  breakIntegration?: boolean;
  /** The settings the terminal adds to claude are invalid, and nothing else. */
  badAdditions?: boolean;
  /** Added to a shell's environment (the self-test's ZDOTDIR). */
  shellEnv?: Record<string, string>;
}

export class VaultTerminal {
  constructor(readonly host: VaultTerminalHost) {
    this.loginPath = host.state?.loginPath ?? "";
  }

  /** The terminal's settings, as the host keeps them. */
  get settings(): TerminalSettings {
    return this.host.settings();
  }

  get app(): App {
    return this.host.plugin.app;
  }

  /** The name the user knows the terminal by: the host's. */
  get name(): string {
    return this.host.name;
  }

  get viewType(): string {
    return this.host.viewType;
  }
  /** Running sessions, so unload can end them all. @internal */
  readonly sessions = new Set<HelperSession>();
  /** Sessions closed but not yet confirmed gone, each with a fallback timer. @internal */
  readonly closing = new Set<HelperSession>();
  private loginPath: string;
  /**
   * The login shell's whole environment, from this session's probe. Kept in
   * memory only: startup files often export API keys, and only PATH is saved.
   */
  private loginEnv: Record<string, string> | null = null;
  /** How the last probe went, for the self-test and for anyone debugging. */
  loginEnvStatus = "not asked";
  private pathProbe: Promise<void> | null = null;

  /** For the self-test: the login shell's environment probe, settled. */
  async loginProbeDone(): Promise<void> {
    await this.pathProbe?.catch(() => undefined);
  }
  /** Aborted by unload(); a new one for each load(). */
  private unloading = new AbortController();
  private python: Promise<{ path: string; version: string }> | null = null;
  private idCounter = 0;

  /** Called by the host from its onload: the view, the events, the guards, and the login shell's probe. */
  load(): void {
    // A VaultTerminal loaded again after unload() starts as new: its probe can run, and closing asks again.
    this.unloading = new AbortController();
    this.closingAllowed = false;
    const plugin = this.host.plugin;
    plugin.registerView(this.viewType, (leaf) => makeTerminalView(leaf, this));

    plugin.registerEvent(this.app.workspace.on("css-change", () => this.refreshLook()));
    // Another vault's waiting count changed; and this vault's old count, from before a reload, is stale.
    plugin.registerDomEvent(window, "storage", (e) => {
      if (e.key === BADGE_KEY) this.showBadge();
    });
    this.app.workspace.onLayoutReady(() => this.updateBadge());
    // Rewritten while there's anything to count: a count another vault's
    // write lost comes back, and a vault that crashed stops counting once its
    // entry is stale.
    plugin.registerInterval(
      window.setInterval(() => {
        if (this.views().some((v) => v.programState === "waiting")) this.updateBadge();
        else this.showBadge();
      }, BADGE_REFRESH_MS),
    );
    plugin.registerEvent(
      // Obsidian says it's quitting before the windows' own close guards run,
      // so an agent that needs a confirm is left running for the guard to
      // see (Cmd+Q had quit without asking). If the quit goes through, the
      // helper ends the program anyway when Obsidian's end closes its pipe.
      this.app.workspace.on("quit", () => {
        for (const view of this.views()) if (this.closingAllowed || !view.needsCloseConfirm()) view.stopSession(false);
      }),
    );

    // Closing a window with a working or waiting agent in it asks first.
    this.guardWindow(window);
    plugin.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.guardWindow(win)));
    // Popouts already open when the plugin loads (a reload, or enabling it) are guarded
    // too: a session moved into one later would otherwise close with it unasked.
    this.app.workspace.onLayoutReady(() => {
      const floating = (this.app.workspace as unknown as { floatingSplit?: { children?: { win?: Window }[] } }).floatingSplit;
      for (const child of floating?.children ?? []) if (child.win && child.win !== window) this.guardWindow(child.win);
    });

    // Off the critical path: terminals use the saved PATH until this answers.
    this.pathProbe = this.refreshLoginEnv();
    // This Mac's automounted folders, whose paths are never looked up on hover (view.ts).
    execFile("/sbin/mount", { timeout: 5000 }, (err, stdout) => {
      if (!err) noteAutomounts(autofsMounts(String(stdout)));
    });
  }

  /**
   * The usual commands (open a terminal or an agent, here or in the right
   * sidebar; the same folder; save the output), for a host that wants them.
   */
  addCommands(): void {
    const plugin = this.host.plugin;
    plugin.addCommand({ id: "open-terminal", name: "Open terminal", callback: () => this.open("shell", "tab") });
    for (const agent of AGENTS) {
      plugin.addCommand({ id: `open-${agent.id}`, name: `Open ${agent.name}`, callback: () => this.open(agent.id, "tab") });
      plugin.addCommand({ id: `open-${agent.id}-right`, name: `Open ${agent.name} in the right sidebar`, callback: () => this.open(agent.id, "right") });
    }
    plugin.addCommand({ id: "open-terminal-right", name: "Open terminal in the right sidebar", callback: () => this.open("shell", "right") });
    plugin.addCommand({
      id: "open-terminal-same-folder",
      name: "Open terminal in the same folder",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (!view) return false;
        if (!checking) void this.open("shell", "tab", view.folder);
        return true;
      },
    });
    plugin.addCommand({
      id: "save-output-to-note",
      name: "Save terminal output to a note",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (!view) return false;
        if (!checking) void this.saveOutput(view);
        return true;
      },
    });

  }

  /** Called by the host from its onunload: every session ends. */
  unload(): void {
    this.unloading.abort();
    this.closingAllowed = true;
    const counts = readCounts();
    delete counts[this.badgeEntry()];
    writeCounts(counts);
    this.showBadge();
    for (const view of this.views()) view.stopSession(false);
    for (const s of this.sessions) s.close(false);
    for (const s of this.closing) s.dropTimers();
    this.sessions.clear();
    this.closing.clear();
  }

  /** Set while the plugin unloads: closing then is the plugin's, not the user's, and never asks. @internal */
  closingAllowed = false;
  /** Set while the self-test runs, which allows closing too: what a check puts back when it's done. @internal */
  selfTesting = false;
  /** Set by the self-test only. @internal */
  test: TestSwitches = {};
  /** Windows whose close the user confirmed: their guard, and their tabs' guards, let them go. @internal */
  confirmedWindows = new WeakSet<Window>();
  /** Windows whose close is guarded already (guardWindow). */
  private guardedWindows = new WeakSet<Window>();
  /** What the last window close guard saw and did, for the self-test to report. @internal */
  lastGuard: { popout: boolean; busy: number; held: boolean; listed: number; live: number } | null = null;
  /** Every open terminal view, whether or not the workspace still lists its leaf (a closing window's may be gone from it). */
  liveViews = new Set<TerminalView>();

  /**
   * A window closing (a popout, or Obsidian's main window when it quits)
   * with an agent in it working or waiting for the user: the close is held, and
   * a confirm asks; confirmed, the window is closed again.
   */
  private guardWindow(win: Window): void {
    if (this.guardedWindows.has(win)) return;
    this.guardedWindows.add(win);
    const plugin = this.host.plugin;
    // In the capture phase, so it runs before handlers Obsidian registered on
    // the window when it made it; and when it holds the close, no later
    // handler runs. The self-test saw the guard find no busy terminal in a
    // closing popout whose agent was working: the workspace no longer listed
    // it. So the views are this plugin's own list, not the workspace's.
    plugin.registerDomEvent(win, "beforeunload", (e: BeforeUnloadEvent) => {
      const { inWin, reasons } = this.heldBy(win);
      if (!inWin) return;
      const busy = reasons.map((x) => x.v);
      this.lastGuard = { popout: win !== window, busy: busy.length, held: busy.length > 0, listed: this.views().filter((v) => v.containerEl.win === win).length, live: inWin.length };
      if (!busy.length) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      // Electron holds a window open only when returnValue is set; preventDefault alone
      // doesn't. The property is deprecated on the web, not in Electron.
      (e as { returnValue: unknown }).returnValue = "";
      confirmClose(this.app, reasons.map((x) => x.why), () => {
        // Obsidian closes a window's tabs as it goes, and each busy tab would
        // ask again: the agents end here, and the window's tabs close freely.
        this.confirmedWindows.add(win);
        for (const v of busy) v.stopSession(false);
        // A host that knows what was asked (a reload) carries it out instead.
        if (!this.host.windowConfirmed?.(win)) win.close();
      }, win, () => this.host.windowKept?.(win));
    }, { capture: true });
    if (win === window) this.holdMainWindow();
  }

  /** The terminals in a window that would hold its close, and why (null: the window may close). */
  private heldBy(win: Window): { inWin: TerminalView[] | null; reasons: { v: TerminalView; why: CloseReason }[] } {
    if (this.closingAllowed || this.confirmedWindows.has(win)) return { inWin: null, reasons: [] };
    const inWin = [...this.liveViews].filter((v) => v.containerEl.win === win);
    const reasons = inWin.map((v) => ({ v, why: v.closeReason() })).filter((x): x is { v: TerminalView; why: CloseReason } => x.why !== null);
    return { inWin, reasons };
  }

  /**
   * Obsidian's main process destroys a closing main window 3 s after its
   * close began unless that close event was prevented (its own "close"
   * listener checks the event's defaultPrevented then). Holding the page's
   * unload doesn't prevent that event, so a cancelled confirm still lost the
   * window a few seconds later. A listener of our own on
   * the window prevents the event while a terminal would hold the close.
   * It runs through @electron/remote, so it arrives after the event has
   * returned; it only has to land before Obsidian's timer reads the flag.
   */
  private holdMainWindow(): void {
    let bw: { on(ev: string, fn: (e: { preventDefault(): void }) => void): void; removeListener(ev: string, fn: (e: { preventDefault(): void }) => void): void } | undefined;
    try {
      const req = (window as unknown as { require?: (m: string) => { getCurrentWindow(): typeof bw } }).require;
      bw = req?.("@electron/remote").getCurrentWindow();
    } catch {
      bw = undefined;
    }
    if (!bw) return;
    const onClose = (e: { preventDefault(): void }) => {
      if (this.heldBy(window).reasons.length) e.preventDefault();
    };
    const target = bw;
    target.on("close", onClose);
    this.host.plugin.register(() => target.removeListener("close", onClose));
  }

  /** What the terminal remembers between loads, for a host that saves its data its own way: give it back as host.state. */
  get state(): VaultTerminalState {
    return { loginPath: this.loginPath };
  }

  /** The settings and the terminal's state, saved by the host. */
  async saveSettings(): Promise<void> {
    await this.host.save({ loginPath: this.loginPath });
  }

  nextId(): string {
    return `${process.pid}-${++this.idCounter}`;
  }

  defaultShell(): string {
    return loginShell("");
  }

  forgetPython(): void {
    this.python = null;
  }

  refreshLook(): void {
    for (const view of this.views()) view.refreshLook();
  }

  /** The "Show pictures" setting changed: every terminal follows it. */
  applyPictures(): void {
    for (const view of this.liveViews) view.applyPictures();
  }

  /** The terminal's text in a new note, in Obsidian's default folder for new notes, and opened. */
  async saveOutput(view: TerminalView): Promise<void> {
    try {
      const text = view.text();
      // A fence longer than any run of backticks in the text.
      let longest = 2;
      for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
      const fence = "`".repeat(longest + 1);
      const stamp = window.moment().format("YYYY-MM-DD HH.mm.ss");
      const parent = this.app.fileManager.getNewFileParent("");
      // The program sets the title: keep it short, and to characters a file name can have.
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
      const name = view.getDisplayText().replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, "-").trim().slice(0, 60) || "Terminal";
      let path = "";
      for (let n = 1; !path || this.app.vault.getAbstractFileByPath(path); n++) {
        path = normalizePath(`${parent.path}/${name} output ${stamp}${n > 1 ? ` ${n}` : ""}.md`);
      }
      const file = await this.app.vault.create(path, `${fence}text\n${text}\n${fence}\n`);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      new Notice(`${this.name}: couldn't save the output: ${(e as Error).message}`);
    }
  }

  /**
   * The dock icon's count: claude sessions waiting for the user. The dock is one for all of Obsidian, and each vault runs its
   * own copy of the plugin, so each vault's count goes in storage every
   * Obsidian window shares, and the badge shows their sum.
   */
  updateBadge(): void {
    // Off, this vault adds nothing to the Dock's count.
    const waiting = this.settings.dockBadge ? this.views().filter((v) => v.programState === "waiting").length : 0;
    const counts = readCounts();
    if (waiting) counts[this.badgeEntry()] = { n: waiting, at: Date.now() };
    else delete counts[this.badgeEntry()];
    writeCounts(counts);
    this.showBadge();
  }

  /** Another vault's count changed. */
  private showBadge(): void {
    const now = Date.now();
    const total = Object.values(readCounts())
      .filter((c) => now - c.at < BADGE_FRESH_MS)
      .reduce((a, c) => a + c.n, 0);
    this.setBadge(total ? String(total) : "");
  }

  private setBadge(text: string): void {
    try {
      const req = (window as unknown as { require: (m: string) => unknown }).require;
      let remote: { app?: { dock?: { setBadge(t: string): void } } } | undefined;
      try {
        remote = req("@electron/remote") as typeof remote;
      } catch {
        remote = (req("electron") as { remote?: typeof remote }).remote;
      }
      remote?.app?.dock?.setBadge(text);
    } catch {
      // no dock access; the tabs still show it
    }
  }

  /**
   * A web address from a terminal (Cmd+click, or a plain click with that
   * setting): to the host, if it takes them (openUrl), or to Obsidian, as
   * a link in a note would go, so the Web viewer or the browser is
   * Obsidian's to decide.
   */
  openUrl(url: string): void {
    if (this.host.openUrl) this.host.openUrl(url);
    else window.open(url);
  }

  /** Whether a click on a link opens it: Cmd+click, or any click when the setting says so. */
  opensLink(event: MouseEvent): boolean {
    return this.settings.linkClick === "click" || event.metaKey;
  }

  /** Cmd+click on a path: a file in the vault opens in Obsidian (at the line, if given); anything else is shown in Finder. */
  openPath(abs: string, line?: number): void {
    const rel = relative(this.vaultFolder(), abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(rel));
      if (file instanceof TFile) {
        void this.openNote(file, line);
        return;
      }
    }
    try {
      (window as unknown as { require(m: string): { shell: { showItemInFolder(p: string): void } } }).require("electron").shell.showItemInFolder(abs);
    } catch {
      new Notice(`${this.name}: couldn't show ${abs} in Finder.`);
    }
  }

  /**
   * A note in the vault that text names: a vault-relative path, or a name
   * alone, resolved as a link written in a note at the vault's root would
   * be (so of two notes with that name, the one Obsidian's links pick).
   */
  vaultNote(text: string): TFile | null {
    if (isAbsolute(text) || text.startsWith("~")) return null;
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(text));
    if (direct instanceof TFile) return direct;
    if (text.includes("/")) return null;
    return this.app.metadataCache.getFirstLinkpathDest(text, "");
  }

  /** A vault path as a path on disk. */
  absolutePath(vaultPath: string): string {
    return join(this.vaultFolder(), vaultPath);
  }

  /** Opens a note, in the tab already showing it if there is one, at a line (1-based) if given. */
  async openNote(file: TFile, line?: number): Promise<void> {
    if (this.host.openNote) {
      this.host.openNote(file, line);
      return;
    }
    const { workspace } = this.app;
    let target: WorkspaceLeaf | null = null;
    workspace.iterateAllLeaves((leaf) => {
      const shown = (leaf.view as { file?: TFile | null }).file;
      if (!target && shown?.path === file.path) target = leaf;
    });
    const eState = line ? { line: line - 1 } : undefined;
    if (target) {
      const leaf: WorkspaceLeaf = target;
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      if (eState) leaf.setEphemeralState(eState);
      return;
    }
    await workspace.getLeaf("tab").openFile(file, eState ? { eState } : undefined);
  }

  /** Whether any Obsidian window has focus, this vault's or another's: then Obsidian is the front app. */
  obsidianInFront(): boolean {
    try {
      const req = (window as unknown as { require: (m: string) => unknown }).require;
      let remote: { BrowserWindow?: { getFocusedWindow(): unknown } } | undefined;
      try {
        remote = req("@electron/remote") as typeof remote;
      } catch {
        remote = (req("electron") as { remote?: typeof remote }).remote;
      }
      if (remote?.BrowserWindow) return remote.BrowserWindow.getFocusedWindow() !== null;
    } catch {
      // fall back to this vault's own windows
    }
    const docs = new Set<Document>([document]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.doc));
    return [...docs].some((d) => d.hasFocus());
  }

  /** Makes Obsidian the front app, from a notification click. */
  activateApp(): void {
    try {
      const req = (window as unknown as { require: (m: string) => unknown }).require;
      let remote: { app?: { focus(o?: { steal: boolean }): void } } | undefined;
      try {
        remote = req("@electron/remote") as typeof remote;
      } catch {
        remote = (req("electron") as { remote?: typeof remote }).remote;
      }
      remote?.app?.focus({ steal: true });
    } catch {
      // the window's own focus() below is the fallback
    }
  }

  private views(): TerminalView[] {
    return this.app.workspace.getLeavesOfType(this.viewType).map((l) => l.view).filter((v): v is TerminalView => v instanceof TerminalView);
  }

  async open(kind: TerminalKind, where: "tab" | "right", cwd?: string): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const leaf: WorkspaceLeaf | null = where === "right" ? workspace.getRightLeaf(false) : workspace.getLeaf("tab");
    if (!leaf) return null;
    await leaf.setViewState({ type: this.viewType, active: true, state: cwd ? { kind, cwd } : { kind } });
    await workspace.revealLeaf(leaf);
    return leaf;
  }

  /** When the probe's failure notice was shown, for the self-test; 0 if it wasn't. */
  probeNoticeAt = 0;
  private probeNoticeShown = false;

  /** The self-test asks the login shell again, with its own startup files. */
  async probeForTest(overlay: Record<string, string>): Promise<void> {
    this.probeNoticeShown = false;
    this.probeNoticeAt = 0;
    await this.refreshLoginEnv(overlay);
  }

  private async refreshLoginEnv(overlay: Record<string, string> = {}): Promise<void> {
    const shell = loginShell(this.settings.shell);
    const t0 = Date.now();
    this.loginEnvStatus = "asking";
    try {
      // From the app's own PATH, as a login shell in Terminal.app starts from
      // launchd's: the startup files then build the PATH the user sees.
      const env = await probeLoginEnv(shell, programEnv(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", overlay), this.unloading.signal);
      const path = (env.PATH ?? "").trim();
      if (!path) throw new Error("the login shell reported an empty PATH");
      this.loginEnv = env;
      this.loginEnvStatus = `answered in ${Date.now() - t0} ms, ${Object.keys(env).length} variables`;
      if (path !== this.loginPath) {
        this.loginPath = path;
        await this.saveSettings();
      }
    } catch (e) {
      this.loginEnvStatus = `failed after ${Date.now() - t0} ms: ${(e as Error).message}`;
      if (this.unloading.signal.aborted) return;
      console.warn(`[vault-terminal] couldn't read the environment from ${shell}; using the saved or default PATH.`, e);
      // Once per load: what was used instead, and where to read about a slow startup file.
      if (!this.probeNoticeShown) {
        this.probeNoticeShown = true;
        this.probeNoticeAt = Date.now();
        const instead = this.loginPath ? "the PATH saved from an earlier start" : "a default PATH";
        new Notice(`${this.name} couldn't read your login shell's environment (${(e as Error).message}), so terminals use ${instead} and agents miss what your startup files export. A slow startup file can skip its slow part when VAULT_TERMINAL_ENV_PROBE is set: see the README.`, 15000);
      }
    }
  }

  private async currentPath(): Promise<string> {
    // Before the first probe ever answers, wait briefly for it rather than miss claude.
    if (!this.loginPath && this.pathProbe) {
      await Promise.race([this.pathProbe, new Promise((r) => window.setTimeout(r, 3000))]);
    }
    const fallback = await fallbackPath();
    return this.loginPath ? mergePath(this.loginPath, fallback) : fallback;
  }

  /** This vault's and this host's entry in the shared waiting counts: two hosts in one vault each keep their own. */
  private badgeEntry(): string {
    return `${this.vaultFolder()}|${this.viewType}`;
  }

  private vaultFolder(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : homedir();
  }

  /** The Python that runs the helper, found once and remembered. */
  async pythonPath(path?: string): Promise<string> {
    if (!this.python) {
      const pathDirs = (path ?? (await this.currentPath())).split(delimiter).filter(Boolean);
      this.python = findPython(this.settings.pythonLocation, pathDirs);
      this.python.catch(() => (this.python = null));
    }
    return (await this.python).path;
  }

  /**
   * An agent's program and environment for a host's own calls outside a
   * terminal (a scheduled run, a quick `claude agents`): the program the
   * terminal would run (its Command's first word, or its Location), and the
   * environment an agent gets (the login shell's, the agent variables, less
   * the stripped names). Never the terminal's additions, and never the
   * Command's other words: a host's own call builds its own arguments.
   */
  async agentProgram(kind: string, cwd = ""): Promise<{ program: string; env: NodeJS.ProcessEnv } | { error: string }> {
    const agent = agentById(kind);
    if (!agent) return { error: `${this.name} doesn't know an agent called ${kind}.` };
    const mine = this.settings.agents[agent.id];
    const words = splitCommand(mine?.command || agent.command);
    const first = words[0] ?? splitCommand(agent.command)[0];
    const path = await this.currentPath();
    try {
      const program = await findProgram(first, mine?.location ?? "", path);
      if (!this.loginEnv && this.pathProbe) await Promise.race([this.pathProbe, new Promise((r) => window.setTimeout(r, 3000))]);
      const env = agentEnv(await pathForScript(program, this.loginEnv?.PATH?.trim() || path), this.loginEnv, this.settings.agentVariables, cwd || this.vaultFolder(), parseNames(this.settings.strippedVariables ?? ""));
      return { program, env };
    } catch (e) {
      const tried = e instanceof NotFoundError ? e.tried : [];
      return { error: `Couldn't find ${first}${tried.length ? ` (looked in ${tried.join(", ")})` : ""}. Set its location in ${this.host.settingsPath} → ${agent.name} → Location of ${splitCommand(agent.command)[0]}.` };
    }
  }

  /** Finds everything a terminal needs, or says plainly what's missing. */
  async prepareLaunch(kind: TerminalKind, folder = "", opts: LaunchOptions = {}): Promise<Launch | { error: string }> {
    opts.step?.("reading your login shell's environment");
    const path = await this.currentPath();
    let python: string;
    try {
      opts.step?.("finding Python");
      python = await this.pythonPath(path);
    } catch (e) {
      const tried = e instanceof NotFoundError && e.tried.length ? `\nTried: ${e.tried.join(", ")}.` : "";
      if (this.settings.pythonLocation) {
        return {
          error:
            `The Python 3 set in ${this.name}'s settings isn't usable (Python 3.8 or later is needed).${tried}` +
            `\nFix or clear ${this.host.settingsPath} → Location of Python 3; cleared, ${this.name} finds Python on its own.`,
        };
      }
      return {
        error:
          `${this.name} needs Python 3 and couldn't find it.` +
          tried +
          `\nInstall it from python.org or with Homebrew (brew install python), or set its location in ${this.host.settingsPath}.`,
      };
    }

    const cwd = opts.host?.folder || folder || this.vaultFolder();
    if (kind === "shell") {
      const shell = loginShell(this.settings.shell);
      // Terminal.app's shells are login shells; -l makes this one too.
      let env = programEnv(path, this.test.shellEnv);
      let integration = false;
      if (this.settings.shellIntegration && !opts.noIntegration && /\/zsh$/.test(shell)) {
        try {
          env = zshIntegrationEnv(env);
          if (this.test.breakIntegration) env.VAULT_TERMINAL_TEST_BREAK_INTEGRATION = "1";
          integration = true;
        } catch (e) {
          console.warn("[vault-terminal] couldn't set up zsh integration; starting without it", e);
        }
      }
      return { python, program: [shell, "-l"], cwd, env, added: [], integration };
    }

    const agent = agentById(kind);
    if (!agent) return { error: `${this.name} doesn't know an agent called ${kind}.` };
    const mine = this.settings.agents[agent.id];
    const words = splitCommand(mine?.command || agent.command);
    if (!words.length) words.push(...splitCommand(agent.command));
    const plain = !!opts.plain || !!opts.host?.plain;
    // A host's plain start (Agent Manager's `claude attach`) is the program and the
    // host's words alone: the Command's other words are launch flags, which attach refuses.
    if (opts.host?.plain) words.splice(1);
    // The host's own arguments, after the command's: they count as the command's, never as additions.
    if (opts.host?.args) words.push(...opts.host.args);
    try {
      opts.step?.(`finding ${words[0]}`);
      const program = await findProgram(words[0], mine?.location ?? "", path);
      // An agent opened as Obsidian starts gets the login shell's variables
      // too: wait briefly for this session's probe, as the first terminal does for PATH.
      if (!this.loginEnv && this.pathProbe) await Promise.race([this.pathProbe, new Promise((r) => window.setTimeout(r, 3000))]);
      // The login shell's PATH exactly, once it has answered.
      const env = agentEnv(await pathForScript(program, this.loginEnv?.PATH?.trim() || path), this.loginEnv, this.settings.agentVariables, cwd, parseNames(this.settings.strippedVariables ?? ""));
      // What the program actually is decides its extras: claude's own flag
      // would make another program set as the command refuse to start.
      const count = words.length;
      const added = prepareAgent(kind, program, words, { env, cwd, pictures: this.settings.showPictures }, plain);
      if (!plain && this.test.badAdditions && words.length > count) words.push("--settings", "{not json");
      return { python, program: [program, ...words.slice(1)], cwd, env, added, integration: false };
    } catch (e) {
      const tried = e instanceof NotFoundError ? e.tried : [];
      new Notice(`${this.name}: ${words[0]} not found. Set its location in ${this.host.settingsPath}.`);
      return {
        error:
          `Couldn't find ${words[0]}. Looked in:\n  ${tried.join("\n  ")}\n` +
          `Set its location in ${this.host.settingsPath} → ${agent.name} → Location of ${splitCommand(agent.command)[0]}.`,
      };
    }
  }
}

const BADGE_KEY = "vault-terminal-waiting";
const BADGE_REFRESH_MS = 60_000;
// An entry older than this is from a vault that stopped updating it (crashed).
const BADGE_FRESH_MS = 3 * BADGE_REFRESH_MS;

interface WaitingCount {
  n: number;
  /** When the vault last wrote it. */
  at: number;
}

/** Each vault's count of waiting sessions, by its folder, from storage all Obsidian windows share. */
function readCounts(): Record<string, WaitingCount> {
  try {
    const counts = JSON.parse(window.localStorage.getItem(BADGE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, WaitingCount> = {};
    for (const [k, v] of Object.entries(counts && typeof counts === "object" ? counts : {})) {
      const c = v as Partial<WaitingCount>;
      if (typeof c?.n === "number" && typeof c.at === "number") out[k] = { n: c.n, at: c.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCounts(counts: Record<string, WaitingCount>): void {
  try {
    if (Object.keys(counts).length) window.localStorage.setItem(BADGE_KEY, JSON.stringify(counts));
    else window.localStorage.removeItem(BADGE_KEY);
  } catch {
    // no storage; this vault's count still shows
  }
}

/**
 * Asks whether to close terminals whose agents are working or waiting for
 * the user, or whose shells are running something, naming what.
 * Cancel, Escape or clicking outside keeps them open.
 */
export function confirmClose(app: App, reasons: CloseReason[], onClose: () => void, win?: Window, onKeep?: () => void): void {
  const modal = new Modal(app);
  modal.modalEl.addClass("vault-terminal-confirm");
  const { title, text } = closeText(reasons);
  modal.titleEl.setText(title);
  modal.contentEl.createEl("p", { text });
  const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
  const close = buttons.createEl("button", { text: "Close", cls: "mod-warning" });
  const cancel = buttons.createEl("button", { text: "Cancel" });
  let closing = false;
  // Cancel, Escape and a click outside all keep it open.
  modal.onClose = () => {
    if (!closing) onKeep?.();
  };
  close.addEventListener("click", () => {
    closing = true;
    modal.close();
    onClose();
  });
  cancel.addEventListener("click", () => modal.close());
  modal.open();
  // In the window being closed, which may not be the one Obsidian opens modals in.
  if (win && modal.containerEl.ownerDocument !== win.document) win.document.body.appendChild(modal.containerEl);
  cancel.focus();
}

/** The mount points /sbin/mount lists as autofs ("map auto_home on /System/Volumes/Data/home (autofs, ...)"). */
export function autofsMounts(mountOutput: string): string[] {
  const out: string[] = [];
  for (const line of mountOutput.split("\n")) {
    const m = line.match(/ on (\/.*?) \(autofs[,)]/);
    if (m) out.push(m[1]);
  }
  return out;
}
