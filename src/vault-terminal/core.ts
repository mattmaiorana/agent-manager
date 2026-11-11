
import { FileSystemAdapter, FuzzySuggestModal, Modal, TFile, TFolder, normalizePath, type App, type WorkspaceLeaf } from "obsidian";
import { homedir } from "os";
import { delimiter, isAbsolute, join, relative } from "path";
import { execFile } from "child_process";
import { statSync } from "fs";
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
import { linksObsidian, parseObsidianLink, pathsEnding } from "./links";
import { notice, setNoticeConfig, setNoticeShow, showNotice } from "./notice";
import { toDesktop, toObsidian, type NotifyWhere } from "./settings";

export type { CloseReason } from "./close";

export interface Launch {
  python: string;
  program: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  added: string[];
  integration: boolean;
}

export interface LaunchOptions {
  plain?: boolean;
  noIntegration?: boolean;
  step?: (what: string) => void;
  host?: HostLaunch;
}

export interface TestSwitches {
  helperDelay?: number;
  breakIntegration?: boolean;
  badAdditions?: boolean;
  shellEnv?: Record<string, string>;
}

export type NotifyKind = "needs" | "info" | "finished";

export type NotifyRoute = NotifyKind | { to: NotifyWhere; seconds: number };

export interface NotificationHandle {
  hide(): void;
  shown(): boolean;
}

export class VaultTerminal {
  constructor(readonly host: VaultTerminalHost) {
    setNoticeConfig(() => ({ on: this.settings?.infoNotices ?? true, ms: (this.settings?.infoSeconds ?? 5) * 1000 }));
    setNoticeShow((message) => this.infoNotice(message));
    this.loginPath = host.state?.loginPath ?? "";
  }

  get settings(): TerminalSettings {
    return this.host.settings();
  }

  get app(): App {
    return this.host.plugin.app;
  }

  get name(): string {
    return this.host.name;
  }

  get viewType(): string {
    return this.host.viewType;
  }

  get plainViewType(): string | undefined {
    return this.host.plainViewType;
  }
  readonly sessions = new Set<HelperSession>();
  readonly closing = new Set<HelperSession>();
  private loginPath: string;
  private loginEnv: Record<string, string> | null = null;
  loginEnvStatus = "not asked";
  private pathProbe: Promise<void> | null = null;

  async loginProbeDone(): Promise<void> {
    await this.pathProbe?.catch(() => undefined);
  }
  private unloading = new AbortController();
  private python: Promise<{ path: string; version: string }> | null = null;
  private idCounter = 0;

  load(): void {
    this.unloading = new AbortController();
    this.closingAllowed = false;
    const plugin = this.host.plugin;
    plugin.registerView(this.viewType, (leaf) => makeTerminalView(leaf, this));
    const plainType = this.plainViewType;
    if (plainType) plugin.registerView(plainType, (leaf) => makeTerminalView(leaf, this, true));

    plugin.registerEvent(this.app.workspace.on("css-change", () => this.refreshLook()));
    const forgetFiles = (): void => {
      this.filesByName = null;
      for (const view of this.liveViews) view.refreshLinks();
    };
    plugin.registerEvent(this.app.vault.on("create", forgetFiles));
    plugin.registerEvent(this.app.vault.on("delete", forgetFiles));
    plugin.registerEvent(this.app.vault.on("rename", forgetFiles));
    plugin.registerDomEvent(window, "storage", (e) => {
      if (e.key === BADGE_KEY) this.showBadge();
    });
    this.app.workspace.onLayoutReady(() => this.updateBadge());
    plugin.registerInterval(
      window.setInterval(() => {
        if (this.views().some((v) => v.programState === "waiting")) this.updateBadge();
        else this.showBadge();
      }, BADGE_REFRESH_MS),
    );
    plugin.registerEvent(
      this.app.workspace.on("quit", () => {
        for (const view of this.views()) if (this.closingAllowed || !view.needsCloseConfirm()) view.stopSession(false);
      }),
    );

    this.guardWindow(window);
    plugin.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.guardWindow(win)));
    this.app.workspace.onLayoutReady(() => {
      const floating = (this.app.workspace as unknown as { floatingSplit?: { children?: { win?: Window }[] } }).floatingSplit;
      for (const child of floating?.children ?? []) if (child.win && child.win !== window) this.guardWindow(child.win);
    });

    this.pathProbe = this.refreshLoginEnv();
    execFile("/sbin/mount", { timeout: 5000 }, (err, stdout) => {
      if (!err) noteAutomounts(autofsMounts(String(stdout)));
    });
  }

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

  unload(): void {
    setNoticeShow(null);
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

  closingAllowed = false;
  selfTesting = false;
  test: TestSwitches = {};
  confirmedWindows = new WeakSet<Window>();
  private guardedWindows = new WeakSet<Window>();
  lastGuard: { popout: boolean; busy: number; held: boolean; listed: number; live: number } | null = null;
  liveViews = new Set<TerminalView>();

  private guardWindow(win: Window): void {
    if (this.guardedWindows.has(win)) return;
    this.guardedWindows.add(win);
    const plugin = this.host.plugin;
    plugin.registerDomEvent(win, "beforeunload", (e: BeforeUnloadEvent) => {
      const { inWin, reasons } = this.heldBy(win);
      if (!inWin) return;
      const busy = reasons.map((x) => x.v);
      this.lastGuard = { popout: win !== window, busy: busy.length, held: busy.length > 0, listed: this.views().filter((v) => v.containerEl.win === win).length, live: inWin.length };
      if (!busy.length) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      (e as { returnValue: unknown }).returnValue = "";
      confirmClose(this.app, reasons.map((x) => x.why), () => {
        this.confirmedWindows.add(win);
        for (const v of busy) v.stopSession(false);
        if (!this.host.windowConfirmed?.(win)) win.close();
      }, win, () => this.host.windowKept?.(win));
    }, { capture: true });
    if (win === window) this.holdMainWindow();
  }

  private heldBy(win: Window): { inWin: TerminalView[] | null; reasons: { v: TerminalView; why: CloseReason }[] } {
    if (this.closingAllowed || this.confirmedWindows.has(win)) return { inWin: null, reasons: [] };
    const inWin = [...this.liveViews].filter((v) => v.containerEl.win === win);
    const reasons = inWin.map((v) => ({ v, why: v.closeReason() })).filter((x): x is { v: TerminalView; why: CloseReason } => x.why !== null);
    return { inWin, reasons };
  }

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

  get state(): VaultTerminalState {
    return { loginPath: this.loginPath };
  }

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

  applyPictures(): void {
    for (const view of this.liveViews) view.applyPictures();
  }

  async saveOutput(view: TerminalView): Promise<void> {
    try {
      const text = view.text();
      let longest = 2;
      for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
      const fence = "`".repeat(longest + 1);
      const stamp = window.moment().format("YYYY-MM-DD HH.mm.ss");
      const parent = this.app.fileManager.getNewFileParent("");
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
      const name = view.getDisplayText().replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, "-").trim().slice(0, 60) || "Terminal";
      let path = "";
      for (let n = 1; !path || this.app.vault.getAbstractFileByPath(path); n++) {
        path = normalizePath(`${parent.path}/${name} output ${stamp}${n > 1 ? ` ${n}` : ""}.md`);
      }
      const file = await this.app.vault.create(path, `${fence}text\n${text}\n${fence}\n`);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      notice(`${this.name}: couldn't save the output: ${(e as Error).message}`);
    }
  }

  updateBadge(): void {
    const waiting = this.settings.dockBadge ? this.views().filter((v) => v.programState === "waiting").length : 0;
    const counts = readCounts();
    if (waiting) counts[this.badgeEntry()] = { n: waiting, at: Date.now() };
    else delete counts[this.badgeEntry()];
    writeCounts(counts);
    this.showBadge();
  }

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
      /* empty */
    }
  }

  openUrl(url: string): void {
    if (this.host.openUrl) this.host.openUrl(url);
    else window.open(url);
  }

  openObsidianUri(uri: string): void {
    if (!linksObsidian(uri)) {
      notice(`${this.name}: only obsidian:// links that open a note or are ${this.name}'s open from a terminal.`);
      return;
    }
    const link = parseObsidianLink(uri);
    if (!link) {
      notice(`${this.name}: that obsidian:// link won't decode (it may be cut short), so it wasn't opened.`);
      return;
    }
    const vault = link.params.vault?.toLowerCase();
    const appId = (this.app as unknown as { appId?: string }).appId;
    const here = !vault || vault === this.app.vault.getName().toLowerCase() || (!!appId && vault === appId.toLowerCase());
    if (link.action !== "open") {
      if (!here || !this.host.openObsidianLink?.(link)) notice(`${this.name}: ${link.action} links open from a terminal only for this vault.`);
      return;
    }
    const { path, file: name } = link.params;
    if (path) {
      this.openPath(path);
      return;
    }
    if (!here) {
      window.open(uri);
      return;
    }
    if (!name) return;
    const bare = name.split("#")[0];
    const file = bare ? this.linkedNote(bare) : null;
    if (file) void this.openNote(file);
    else notice(`${this.name}: there's no note “${name.slice(0, 200)}” in this vault.`);
  }

  obsidianTarget(uri: string): { text: string; found: boolean | null } | null {
    if (!linksObsidian(uri)) return null;
    const link = parseObsidianLink(uri);
    if (!link) return { text: "Won't decode", found: false };
    const vault = link.params.vault?.toLowerCase();
    const appId = (this.app as unknown as { appId?: string }).appId;
    const here = !vault || vault === this.app.vault.getName().toLowerCase() || (!!appId && vault === appId.toLowerCase());
    const { path, file, op, session, note } = link.params;
    if (link.action === "open") {
      if (path) return { text: path, found: null };
      if (!here) return { text: `A note in the vault “${link.params.vault}”${file ? `: ${file}` : ""}`, found: null };
      if (!file) return { text: "This vault", found: null };
      const bare = file.split("#")[0];
      const hit = bare ? this.linkedNote(bare) : null;
      return { text: hit ? hit.path : `No note “${file}” in this vault`, found: !!hit };
    }
    if (!here) return { text: `${this.name}: another vault's link, which doesn't open from here`, found: null };
    if (op === "resume" || (!op && session)) {
      const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session ?? "");
      return { text: ok ? `Resume session ${session.slice(0, 8)}` : "Not a session ID", found: ok };
    }
    if (op === "new" && note) {
      const hit = this.app.vault.getAbstractFileByPath(normalizePath(note));
      return { text: hit ? `Start a session from ${hit.path}` : `No note or folder “${note}”`, found: !!hit };
    }
    if (op === "new") return { text: "Start a new session", found: null };
    if (op === "daily") return { text: "Open today's chat", found: null };
    return { text: `${this.name}: ${op ?? "link"}`, found: null };
  }

  private linkedNote(name: string): TFile | null {
    for (const p of [name, `${name}.md`]) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(p));
      if (file instanceof TFile) return file;
    }
    return this.app.metadataCache.getFirstLinkpathDest(name, "");
  }

  opensLink(event: MouseEvent): boolean {
    return this.settings.linkClick === "click" || event.metaKey;
  }

  openPath(abs: string, line?: number): void {
    const rel = relative(this.vaultFolder(), abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(rel));
      if (file instanceof TFile) {
        void this.openNote(file, line);
        return;
      }
      const explorer = (this.app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): { revealInFolder?(f: TFolder): void } | null } }).internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (file instanceof TFolder && explorer?.revealInFolder) {
        explorer.revealInFolder(file);
        return;
      }
    }
    try {
      (window as unknown as { require(m: string): { shell: { showItemInFolder(p: string): void } } }).require("electron").shell.showItemInFolder(abs);
    } catch {
      notice(`${this.name}: couldn't show ${abs} in Finder.`);
    }
  }

  vaultNotes(text: string): TFile[] {
    if (isAbsolute(text) || text.startsWith("~")) return [];
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(text));
    if (direct instanceof TFile) return [direct];
    const files: TFile[] = [];
    for (const path of pathsEnding(this.filesNamed(text.slice(text.lastIndexOf("/") + 1)), text)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) files.push(file);
    }
    return files;
  }

  openNotes(files: TFile[], line?: number): void {
    if (files.length === 1) void this.openNote(files[0], line);
    else if (files.length > 1) new NotePicker(this.app, files, (file) => void this.openNote(file, line)).open();
  }

  private filesByName: Map<string, string[]> | null = null;

  private filesNamed(name: string): string[] {
    if (!this.filesByName) {
      this.filesByName = new Map();
      for (const f of this.app.vault.getFiles()) {
        const key = f.name.toLowerCase();
        const list = this.filesByName.get(key);
        if (list) list.push(f.path);
        else this.filesByName.set(key, [f.path]);
      }
    }
    return this.filesByName.get(name.toLowerCase()) ?? [];
  }

  absolutePath(vaultPath: string): string {
    return join(this.vaultFolder(), vaultPath);
  }

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

  notify(title: string, body: string, onClick?: () => void, key = title, kind: NotifyRoute = "needs"): NotificationHandle {
    const s = this.settings;
    const to: NotifyWhere = typeof kind === "object" ? kind.to : kind === "needs" ? s.needsYouTo : kind === "finished" ? s.finishedTo : s.infoNotices ? "obsidian" : "none";
    const parts: NotificationHandle[] = [];
    const handle: NotificationHandle = {
      hide: () => {
        for (const p of parts) p.hide();
      },
      shown: () => parts.some((p) => p.shown()),
    };
    if (toDesktop(to)) {
      const n = this.desktopNotify(title, body, onClick);
      if (n) parts.push({ hide: () => n.close(), shown: () => false });
    }
    if (!toObsidian(to)) return handle;
    const ms = (typeof kind === "object" ? kind.seconds : kind === "needs" ? s.needsYouSeconds : kind === "finished" ? s.finishedSeconds : s.infoSeconds) * 1000;
    const active = this.app.workspace.getActiveViewOfType(TerminalView);
    const there = active?.looking() ? active : this.views().find((v) => v.looking());
    if (there) {
      const box = there.showToast(title, body, ms, onClick, key);
      if (box.shown()) {
        parts.push(box);
        return handle;
      }
    }
    parts.push(this.stackNotice(title, body, ms, onClick));
    return handle;
  }

  infoNotice(message: string): void {
    if (!this.settings.infoNotices) return;
    const ms = this.settings.infoSeconds * 1000;
    const prefix = `${this.name}: `;
    const text = message.startsWith(prefix) ? message.charAt(prefix.length).toUpperCase() + message.slice(prefix.length + 1) : message;
    const active = this.app.workspace.getActiveViewOfType(TerminalView);
    const shown = this.views().filter((v) => v.looking());
    const there = active?.looking() ? active : shown.length === 1 ? shown[0] : null;
    if (there && !there.containerEl.ownerDocument.querySelector(".modal-container") && there.showToast(this.name, text, ms, undefined, undefined, true).shown()) return;
    this.stackNotice(this.name, text, ms, undefined, true);
  }

  private stackNotice(title: string, body: string, ms: number, onClick?: () => void, info = false): NotificationHandle {
    const content = createFragment((f) => {
      f.createDiv({ cls: "vault-terminal-toast-title", text: title });
      f.createDiv({ cls: "vault-terminal-toast-text", text: body });
    });
    const shown = showNotice(content, ms);
    const box = shown.messageEl.closest<HTMLElement>(".notice") ?? shown.messageEl;
    box.addClass("vault-terminal-notice");
    if (info) box.addClass("is-info");
    if (this.settings.fontFamily.trim()) box.style.fontFamily = this.settings.fontFamily.trim();
    box.style.fontSize = `${this.settings.fontSize}px`;
    if (onClick) box.addEventListener("click", () => onClick());
    return { hide: () => shown.hide(), shown: () => box.isConnected };
  }

  private desktopNotify(title: string, body: string, onClick?: () => void): Notification | null {
    try {
      const n = new Notification(title, { body: body.slice(0, 240), silent: false });
      n.onclick = () => {
        this.activateApp();
        window.focus();
        onClick?.();
      };
      return n;
    } catch (e) {
      console.error("[vault-terminal] notification failed", e);
      return null;
    }
  }

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
      /* empty */
    }
  }

  private views(): TerminalView[] {
    const types = this.plainViewType ? [this.viewType, this.plainViewType] : [this.viewType];
    return types.flatMap((t) => this.app.workspace.getLeavesOfType(t)).map((l) => l.view).filter((v): v is TerminalView => v instanceof TerminalView);
  }

  async open(kind: TerminalKind, where: "tab" | "right", cwd?: string): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const leaf: WorkspaceLeaf | null = where === "right" ? workspace.getRightLeaf(false) : workspace.getLeaf("tab");
    if (!leaf) return null;
    const type = kind === "shell" && this.plainViewType ? this.plainViewType : this.viewType;
    await leaf.setViewState({ type, active: true, state: cwd ? { kind, cwd } : { kind } });
    await workspace.revealLeaf(leaf);
    return leaf;
  }

  probeNoticeAt = 0;
  private probeNoticeShown = false;

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
      console.warn(`[vault-terminal] couldn't read the environment from ${shell}; using the saved or default PATH. A slow startup file can skip its slow part when VAULT_TERMINAL_ENV_PROBE is set, which it is only while the terminal reads the environment.`, e);
      if (!this.probeNoticeShown) {
        this.probeNoticeShown = true;
        this.probeNoticeAt = Date.now();
        const instead = this.loginPath ? "the PATH saved from an earlier start" : "a default PATH";
        this.notify(`${this.name} couldn't read your login shell's environment`, `${(e as Error).message}. Terminals use ${instead}, so agents miss what your startup files export. The console says more.`);
      }
    }
  }

  private async currentPath(): Promise<string> {
    if (!this.loginPath && this.pathProbe) {
      await Promise.race([this.pathProbe, new Promise((r) => window.setTimeout(r, 3000))]);
    }
    const fallback = await fallbackPath();
    return this.loginPath ? mergePath(this.loginPath, fallback) : fallback;
  }

  private badgeEntry(): string {
    return `${this.vaultFolder()}|${this.viewType}`;
  }

  private vaultFolder(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : homedir();
  }

  async pythonPath(path?: string): Promise<string> {
    if (!this.python) {
      const pathDirs = (path ?? (await this.currentPath())).split(delimiter).filter(Boolean);
      this.python = findPython(this.settings.pythonLocation, pathDirs);
      this.python.catch(() => (this.python = null));
    }
    return (await this.python).path;
  }

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

    let cwd = opts.host?.folder || folder || this.vaultFolder();
    if (kind === "shell") {
      if (!isDirectory(cwd)) cwd = this.vaultFolder();
      const shell = loginShell(this.settings.shell);
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
    if (opts.host?.plain) words.splice(1);
    if (opts.host?.args) words.push(...opts.host.args);
    try {
      opts.step?.(`finding ${words[0]}`);
      const program = await findProgram(words[0], mine?.location ?? "", path);
      if (!this.loginEnv && this.pathProbe) await Promise.race([this.pathProbe, new Promise((r) => window.setTimeout(r, 3000))]);
      const env = agentEnv(await pathForScript(program, this.loginEnv?.PATH?.trim() || path), this.loginEnv, this.settings.agentVariables, cwd, parseNames(this.settings.strippedVariables ?? ""));
      if (opts.host?.env) Object.assign(env, opts.host.env);
      const count = words.length;
      const added = prepareAgent(kind, program, words, { env, cwd, pictures: this.settings.showPictures }, plain);
      if (!plain && this.test.badAdditions && words.length > count) words.push("--settings", "{not json");
      return { python, program: [program, ...words.slice(1)], cwd, env, added, integration: false };
    } catch (e) {
      const tried = e instanceof NotFoundError ? e.tried : [];
      this.notify(this.name, `${words[0]} not found. Set its location in ${this.host.settingsPath}.`);
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
const BADGE_FRESH_MS = 3 * BADGE_REFRESH_MS;

interface WaitingCount {
  n: number;
  at: number;
}

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
    /* empty */
  }
}

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
  if (win && modal.containerEl.ownerDocument !== win.document) win.document.body.appendChild(modal.containerEl);
  cancel.focus();
}

export function autofsMounts(mountOutput: string): string[] {
  const out: string[] = [];
  for (const line of mountOutput.split("\n")) {
    const m = line.match(/ on (\/.*?) \(autofs[,)]/);
    if (m) out.push(m[1]);
  }
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

class NotePicker extends FuzzySuggestModal<TFile> {
  private readonly files: TFile[];

  constructor(app: App, files: TFile[], private readonly onPick: (file: TFile) => void) {
    super(app);
    this.files = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);
    this.setPlaceholder(`${files.length} files named ${files[0].name}: most recently edited first`);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
