
import { ItemView, Menu, Scope, getIconIds, setIcon, type Modifier, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { Terminal, type ILink, type IBuffer, type IBufferLine, type IBufferRange, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { statSync } from "fs";
import { execFileSync } from "child_process";
import { homedir, hostname } from "os";
import { isAbsolute, join, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { confirmClose, type NotificationHandle, type VaultTerminal } from "./core";
import type { CloseReason } from "./close";
import type { TerminalController } from "./host";
import { afterExitKey, ctrlCCopies, dragSelection, gestureFocus, gestureReports, KeyQueue, movesTo, replayPlan, rowBreaks, SELECT_MOVE_KEYS, selectMove, selectsInBox, startSelection, textMove, typesCharacter, unwrapCopy, dedentCopy, type Cell, type InputRow, type Gesture, type QueueHold, type QueueItem, type SelectMove, type TextArea } from "./keys";
import { HelperSession, validSize, type ExitInfo, type Foreground, type StartError } from "./session";
import { cliWrapped, findPaths, findUrlsAcross, type FoundPath, type RowCells } from "./links";
import { clipboardHasOnlyImage, clipboardText, copyText } from "./clipboard";
import { StatusTracker, type Attention, type ProgramState } from "./status";
import { agentById, agentFor, agentForProgram, type AgentProfile } from "./agents";
import { readLook } from "./theme";
import { ReportQueue, WheelCounter, scrollSpeed } from "./wheel";
import { cellSize, resyncViewport, scrollBuffer, sendButtonReport, sendWheelReport, stopUnderliningLinks, underlineLinks } from "./xterm-internals";
import { PictureLayer } from "./pictures";
import { GraphicsFilter, PICTURE_LINK, findPattern, withoutPlaceholders } from "./kitty";
import { addCloseX, noticeMs, noticesOn } from "./notice";
import { toDesktop, toObsidian } from "./settings";


declare const XTERM_VERSION: string;

interface TopAnchor {
  marker: IMarker;
  chars: number;
  text: string;
  fromEnd: number;
}
export type TerminalKind = string;

interface StartOptions {
  plain?: boolean;
  noIntegration?: boolean;
}

const SHELLS = /^(zsh|bash|fish|sh|dash|ksh|mksh|tcsh|csh|nu|elvish|xonsh)(-[\d.]+)?$/;
const WORD_SEPARATORS = " ()[]{}',\"`─│┌┐└┘├┤┬┴┼╭╮╯╰‘’“”|";
const RESIZE_SPACING_MS = 125;
const SLOW_START_MS = 5000;
const RETRY_WITHIN_MS = 5000;

const OUTPUT_HIGH = 512 * 1024;
const OUTPUT_LOW = 128 * 1024;
const MEASURE_RETRIES = 30;
const FRAME_FALLBACK_MS = 300;

const CTRL_COMBOS: Modifier[][] = [["Ctrl"], ["Ctrl", "Shift"], ["Ctrl", "Alt"], ["Ctrl", "Shift", "Alt"]];
const ANY_MODIFIERS = ["Escape", "Tab", "Enter", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const FUNCTION_KEYS = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);
const CMD_KEYS = ["A", "C", "V", "X", "K", "F", "G", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Backspace", "Delete", "Z"];
const MAX_PROMPT_MARKS = 1000;
const cursorStyleOf = (c: string): "bar" | "block" | "underline" => (c === "block" || c === "underline" ? c : "bar");
const inactiveCursorOf = (c: string): "bar" | "outline" | "underline" => (c === "block" ? "outline" : c === "underline" ? "underline" : "bar");
const SELECT_HOLD_MS = 400;
const SELECT_SETTLE_MS = 80;
const RESET_FOLLOW_MS = 1000;
const RESET_ROWS = 5;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);
const CLIPBOARD_WRITE_LIMIT = 8 * 1024 * 1024;
const PROMPT_ROWS = 80;
const DRAG_STEP_MS = 20;
const COPY_UNWRAP_MS = 2000;
const COPY_KEEP_MS = 2500;
const COPY_CHECK_MS = 25;
const CLEAR_KEY_GAP_MS = 15;
const COPIED_SHOWN = 80;
const TOAST_STACK = 3;
const INFO_STACK = 3;
let noticeKeys = 0;

const PATHS_KEPT_MS = 5000;
const PATHS_KEPT_MAX = 600;
const LINKS_CHANGED_MS = 100;
const LINK_ROWS_KEPT = 2000;
const JOINED_LINES = 2;

const STATE_ICONS: Record<ProgramState | "bell", string[]> = {
  running: [],
  unknown: ["circle-help", "circle-question-mark", "help-circle"],
  working: ["loader", "loader-circle"],
  idle: [],
  waiting: ["circle-alert", "alert-circle"],
  error: ["octagon-x", "x-octagon", "circle-x"],
  paused: ["circle-pause", "pause-circle", "pause"],
  finished: ["circle-check", "check-circle"],
  exited: ["circle-slash", "slash", "square"],
  bell: ["bell"],
};

let constructingType = "";

export function makeTerminalView(leaf: WorkspaceLeaf, core: VaultTerminal, plain = false): TerminalView {
  constructingType = plain && core.plainViewType ? core.plainViewType : core.viewType;
  try {
    return new TerminalView(leaf, core);
  } finally {
    constructingType = "";
  }
}

export class TerminalView extends ItemView {
  kind: TerminalKind = "shell";
  private stateKnown = false;
  private pane!: HTMLElement;
  private term: Terminal | null = null;
  private fit = new FitAddon();
  private opened = false;
  private session: HelperSession | null = null;
  private starting = false;
  private ended = false;
  private observer: ResizeObserver | null = null;
  private frame = 0;
  private fallback = 0;
  private frameWin: Window | null = null;
  private retries = 0;
  private unhookMigrate: (() => void) | null = null;
  private unparsed = 0;
  private paused = false;
  private readsKittyKeys = false;
  private runningAgent: AgentProfile | null = null;
  private winFocus: { win: Window; fn: () => void } | null = null;
  private status: StatusTracker | null = null;
  private bellMarked = false;
  private startDir = homedir();
  private currentDir: string | null = null;
  private pathsKept = new Map<string, { at: number; found: FoundPath[] }>();
  private linkRowsDrawn = new Map<number, string>();
  private linksThisRender = new Map<number, ILink[]>();
  private pointer: { x: number; y: number; alt: boolean } | null = null;
  private linksChanged = 0;
  private linksChangedWin: Window | null = null;
  private hoverCheck = 0;
  private hoverCheckWin: Window | null = null;
  private promptSelection: { text: string; indent: number; col: number; row: number; length: number } | null = null;
  private pendingSends = new Set<number>();
  private keyQueue = new KeyQueue(
    (data) => {
      if (this.session && this.session === this.queueSession) this.sendNow(data);
      else this.keyQueue.clear();
    },
    (fn, ms) => this.pane.win.setTimeout(fn, ms),
    (timer) => this.pane.win.clearTimeout(timer as number),
    CLEAR_KEY_GAP_MS,
  );
  private queueSession: HelperSession | null = null;
  private queueWriting = false;
  private selectionKnown: Gesture | null = null;
  private get claudeSelection(): Gesture | null {
    return this.selectionKnown;
  }
  private set claudeSelection(g: Gesture | null) {
    this.selectionKnown = g && g.top === undefined ? { ...g, top: this.promptBox()?.top } : g;
    if (!!g === this.pane?.hasClass("vault-terminal-selecting")) return;
    this.pane?.toggleClass("vault-terminal-selecting", !!g);
    this.applyCursor();
  }

  private applyCursor(): void {
    if (!this.term) return;
    const s = this.core.settings;
    const hidden = !!this.selectionKnown;
    this.term.options.cursorStyle = hidden ? "bar" : cursorStyleOf(s.cursor);
    this.term.options.cursorBlink = !hidden && s.cursorBlink;
    this.term.options.cursorInactiveStyle = hidden ? "bar" : inactiveCursorOf(s.cursor);
  }
  private lastPress: Cell & { at: number } = { col: -9, row: -9, at: 0 };
  private pressedAt: Cell | null = null;
  private copyBreaks: { breaks: { breaks: string[]; indent: number } | null; at: number; copied?: () => void }[] = [];
  private toasts: HTMLElement | null = null;
  private toastTimers = new Map<HTMLElement, { win: Window; id: number }>();
  private cutTimers = new Set<{ win: Window; id: number }>();
  readonly noticeKey = `session-${++noticeKeys}`;
  private unguardClose: (() => void) | null = null;
  private promptMarks: IMarker[] = [];
  private search = new SearchAddon();
  private searchBar: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchCount: HTMLElement | null = null;
  ownWheel = true;
  private pending: { kind: TerminalKind; folder: string; opts: StartOptions } | null = null;
  private launch: { kind: TerminalKind; folder: string; added: string[]; integration: boolean; plain: boolean; at: number } | null = null;
  private slow: { timer: number; step: string; shown: boolean } | null = null;
  private ranProgram = false;
  private wheel = new WheelCounter();
  private reports = new ReportQueue();
  private reportAt: { col: number; row: number; mods: { shift: boolean; alt: boolean; ctrl: boolean }; px: { x: number; y: number } } | null = null;
  private reportFrame = 0;
  private reportWin: Window | null = null;
  private reset: { rows: string[]; from: number; until: number; timer: number; lastLook: number; trailing: number } | null = null;
  private anchor: TopAnchor | null = null;
  private lastFitAt = 0;
  private fitTimer = 0;
  private fitTimerWin: Window | null = null;
  private picturesLayer: PictureLayer | null = null;
  private picturesDrain: GraphicsFilter | null = null;
  private foreground: Foreground | null = null;
  private recognized: AgentProfile | null = null;
  private shellStatus: StatusTracker | null = null;
  readonly controller: TerminalController | null;
  private holdStart = false;
  private top!: HTMLElement;
  private stage!: HTMLElement;
  private decoder: TextDecoder | null = null;

  private readonly ownType: string;

  constructor(leaf: WorkspaceLeaf, private core: VaultTerminal) {
    super(leaf);
    this.ownType = constructingType;
    this.controller = this.ownType === core.plainViewType ? null : (core.host.controller?.(this) ?? null);
    this.holdStart = !!this.controller?.gated;
    this.navigation = false;
    this.scope = new Scope(this.app.scope);
    const claim = () => true;
    this.scope.register(["Ctrl"], "Tab", (e) => this.obsidianHotkey(e));
    this.scope.register(["Ctrl", "Shift"], "Tab", (e) => this.obsidianHotkey(e));
    for (const mods of CTRL_COMBOS) this.scope.register(mods, null, claim);
    for (const key of [...ANY_MODIFIERS, ...FUNCTION_KEYS]) {
      for (const mods of [[], ["Shift"], ["Alt"], ["Shift", "Alt"]] as Modifier[][]) this.scope.register(mods, key, claim);
    }
    for (const key of CMD_KEYS) this.scope.register(["Meta"], key, claim);
    this.scope.register(["Meta", "Shift"], "G", claim);
  }

  override getViewType(): string {
    return this.ownType || constructingType;
  }

  override getDisplayText(): string {
    const own = this.controller?.name?.();
    if (own) return own;
    const name = this.status?.title || this.foregroundName() || agentById(this.kind)?.name || "Terminal";
    const percent = this.status?.percent;
    const text = this.status?.statusText;
    return `${percent !== null && percent !== undefined ? `${percent}% ` : ""}${name}${text ? ` · ${text}` : ""}`;
  }

  private guarded<A extends unknown[], R>(fallback: R, fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      try {
        return fn(...args);
      } catch (e) {
        console.error(`${this.core.name}: a handler for the program's output failed`, e);
        return fallback;
      }
    };
  }

  override getIcon(): string {
    const ids = getIconIds();
    const has = (id: string) => ids.includes(id) || ids.includes(`lucide-${id}`);
    const hostIcon = this.controller?.icon?.();
    const plain = (hostIcon && has(hostIcon) ? hostIcon : null) ?? agentById(this.kind)?.icons.find(has) ?? (this.kind === "shell" ? "terminal-square" : "bot");
    if (this.core?.settings.statusIcons === false) return plain;
    const state = this.bellMarked ? "bell" : this.status?.shown;
    if (!state) return plain;
    return (Object.hasOwn(STATE_ICONS, state) ? STATE_ICONS[state] : []).find(has) ?? plain;
  }

  get programState(): ProgramState | null {
    return this.status?.shown ?? null;
  }

  get bellShown(): boolean {
    return this.bellMarked;
  }

  override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    this.controller?.paneMenu?.(menu, source);
  }

  override getState(): Record<string, unknown> {
    const state: Record<string, unknown> = { ...super.getState(), kind: this.kind };
    if (this.cwd) state.cwd = this.cwd;
    const hosted = this.controller?.getState?.();
    if (hosted) state.host = hosted;
    return state;
  }

  private cwd = "";

  get folder(): string {
    return this.currentDir ?? this.startDir;
  }

  get promptCount(): number {
    return this.promptMarks.length;
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const kind = (state as { kind?: unknown } | null)?.kind;
    if (!this.session && !this.starting && typeof kind === "string" && (kind === "shell" || agentById(kind))) this.kind = kind;
    const cwd = (state as { cwd?: unknown } | null)?.cwd;
    if (!this.session && !this.starting && typeof cwd === "string") this.cwd = cwd;
    const hosted = (state as { host?: unknown } | null)?.host;
    this.controller?.setState?.(hosted && typeof hosted === "object" ? (hosted as Record<string, unknown>) : {});
    this.stateKnown = true;
    await super.setState(state, result);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.schedule();
  }

  protected override async onOpen(): Promise<void> {
    this.core.liveViews.add(this);
    this.contentEl.empty();
    this.contentEl.addClass("vault-terminal-content");
    this.top = this.contentEl.createDiv({ cls: "vault-terminal-top" });
    this.stage = this.contentEl.createDiv({ cls: "vault-terminal-stage" });
    this.pane = this.stage.createDiv({ cls: "vault-terminal-view" });

    const term = new Terminal({
      allowProposedApi: true,
      fontSize: this.core.settings.fontSize,
      letterSpacing: this.core.settings.letterSpacing,
      lineHeight: this.core.settings.lineHeight,
      scrollback: this.core.settings.scrollback,
      macOptionIsMeta: this.core.settings.optionKey === "meta",
      macOptionClickForcesSelection: true,
      cursorStyle: cursorStyleOf(this.core.settings.cursor),
      cursorBlink: this.core.settings.cursorBlink,
      cursorInactiveStyle: inactiveCursorOf(this.core.settings.cursor),
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 4.5,
      windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
      reflowCursorLine: true,
      wordSeparator: WORD_SEPARATORS,
      linkHandler: {
        activate: (event, uri, range) => {
          const shown = this.textIn(range).trim();
          if (event.metaKey || (this.core.opensLink(event) && sameAddress(shown, uri))) this.openUri(uri);
        },
        hover: (event, uri, range) => {
          if (uri !== PICTURE_LINK) this.showLinkTip(event, uri, sameAddress(this.textIn(range).trim(), uri));
          else term.element?.querySelector(".xterm-screen")?.classList.remove("xterm-cursor-pointer");
        },
        leave: () => this.hideLinkTip(),
        allowNonHttpProtocols: true,
      },
    });
    term.loadAddon(this.fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(this.search);
    term.unicode.activeVersion = "11";
    term.attachCustomKeyEventHandler((e) => this.onKey(e));
    term.registerLinkProvider({ provideLinks: (y, cb) => cb(this.linksOn(y)) });
    term.onData((d) => this.onInput(d));
    term.onBinary((d) => this.session?.write(Buffer.from(d, "binary")));
    term.parser.registerCsiHandler({ prefix: ">", final: "q" }, this.guarded(false, (params: (number | number[])[]) => {
      if (params.length > 1 || (params[0] !== undefined && params[0] !== 0)) return false;
      this.session?.write(`\x1bP>|xterm.js(${XTERM_VERSION})\x1b\\`);
      return true;
    }));
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, this.guarded(false, () => {
      this.readsKittyKeys = true;
      return false;
    }));
    term.parser.registerOscHandler(7501, this.guarded(true, (data: string) => {
      if (data === "?") this.status?.statusQuery();
      return true;
    }));
    term.parser.registerOscHandler(99, this.guarded(true, (data: string) => {
      this.status?.kittyNotification(data);
      return true;
    }));
    term.parser.registerOscHandler(9, this.guarded(true, (data: string) => {
      this.status?.otherNotification(9, data);
      return true;
    }));
    term.parser.registerOscHandler(21337, this.guarded(true, (data: string) => {
      this.status?.sessionStatus(data);
      return true;
    }));
    term.parser.registerOscHandler(777, this.guarded(true, (data: string) => {
      this.status?.otherNotification(777, data);
      return true;
    }));
    term.parser.registerOscHandler(7, this.guarded(true, (data: string) => {
      const m = data.match(/^file:\/\/([^/]*)(\/.*)$/);
      if (m && isThisMac(m[1])) {
        let path = m[2];
        try {
          path = decodeURIComponent(path);
        } catch {
          /* empty */
        }
        this.currentDir = path;
      }
      return true;
    }));
    term.parser.registerOscHandler(7766, this.guarded(true, (data: string) => {
      if (data === "integration-failed") this.integrationFailed();
      return true;
    }));
    term.parser.registerOscHandler(133, this.guarded(true, (data: string) => {
      if (data === "A" || data.startsWith("A;")) {
        if (!this.runningAgent) {
          this.readsKittyKeys = false;
          this.status?.programReturned();
        }
        const mark = term.registerMarker(0);
        if (mark) {
          this.promptMarks.push(mark);
          mark.onDispose(() => this.promptMarks.splice(this.promptMarks.indexOf(mark) >>> 0, 1));
          if (this.promptMarks.length > MAX_PROMPT_MARKS) this.promptMarks[0].dispose();
        }
      }
      return true;
    }));
    term.parser.registerOscHandler(52, this.guarded(true, (data: string) => {
      if (!this.core.settings.programClipboard) return true;
      const semi = data.indexOf(";");
      const payload = semi < 0 ? "" : data.slice(semi + 1);
      if (!payload || payload === "?" || payload.length > CLIPBOARD_WRITE_LIMIT) return true;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return true;
      const raw = Buffer.from(payload, "base64").toString("utf8");
      while (this.copyBreaks[0] && performance.now() - this.copyBreaks[0].at > COPY_UNWRAP_MS) this.copyBreaks.shift();
      const sent = this.copyBreaks.shift();
      const breaks = sent?.breaks;
      const text = breaks ? unwrapCopy(raw, breaks.breaks, breaks.indent) : this.isClaude() ? dedentCopy(raw) : raw;
      copyText(text);
      if (text !== raw) this.keepCopy(raw, text);
      this.saidCopied(text, true);
      sent?.copied?.();
      return true;
    }));
    this.registerDomEvent(this.pane, "keydown", (e) => this.trackOption(e), { capture: true });
    this.registerDomEvent(this.pane, "keyup", (e) => this.trackOption(e), { capture: true });
    this.registerDomEvent(this.pane, "focusout", () => {
      this.rightOption = this.leftOption = false;
      this.applyOptionKey();
    });
    this.registerDomEvent(this.pane, "wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    this.registerDomEvent(this.pane, "paste", (e) => {
      if (!e.clipboardData?.getData("text/plain")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { capture: true });
    let rightHeld = false;
    this.registerDomEvent(this.pane, "mousedown", (e) => {
      if (e.button !== 2) {
        this.promptSelection = null;
        this.claudeSelection = null;
        this.pressedAt = e.button === 0 && !e.altKey && term.modes.mouseTrackingMode !== "none" && this.isClaude() ? this.cellAt(e) : null;
        if (this.pressedAt) this.lastPress = { ...this.pressedAt, at: performance.now() };
        return;
      }
      rightHeld = !e.shiftKey && term.modes.mouseTrackingMode !== "none";
      if (rightHeld) e.stopPropagation();
    }, { capture: true });
    this.registerDomEvent(this.pane, "mouseup", (e) => {
      if (e.button === 0 && this.pressedAt) {
        const up = this.cellAt(e);
        const made = !!up && term.modes.mouseTrackingMode !== "none" && selectsInBox(this.pressedAt, up, e.detail, this.promptBox());
        this.claudeSelection = made && up ? { from: this.pressedAt, to: up, clicks: e.detail >= 2 ? e.detail : 1, whole: false } : null;
        this.pressedAt = null;
      }
      if (e.button !== 2) return;
      if (rightHeld) e.stopPropagation();
      rightHeld = false;
    }, { capture: true });
    this.registerDomEvent(this.pane, "contextmenu", (e) => {
      if (term.modes.mouseTrackingMode === "none") return;
      e.stopPropagation();
      e.preventDefault();
      if (!e.shiftKey) this.showMenu(e);
    }, { capture: true });
    this.registerDomEvent(this.pane, "dragover", (e) => {
      if (this.droppedPaths(e).length || e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }
    }, { capture: true });
    this.registerDomEvent(this.pane, "drop", (e) => {
      const paths = this.droppedPaths(e);
      if (!paths.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.typePaths(paths);
    }, { capture: true });
    this.registerDomEvent(this.pane, "contextmenu", (e) => {
      if (term.modes.mouseTrackingMode === "none") this.showMenu(e);
    });
    term.parser.registerCsiHandler({ final: "J" }, this.guarded(false, (params: (number | number[])[]) => {
      if (params[0] === 3) this.noteReset();
      return false;
    }));
    term.onWriteParsed(this.guarded(undefined, () => this.followReset(false)));
    term.onTitleChange(this.guarded(undefined, (title: string) => this.status?.setTitle(title)));
    term.onBell(this.guarded(undefined, () => this.onBell()));
    term.onScroll(() => this.hideLinkTip());
    term.onRender(this.guarded(undefined, (e: { start: number; end: number }) => this.afterRender(e.start, e.end)));
    this.registerDomEvent(this.pane, "mousemove", (e) => {
      if (e.isTrusted) this.pointer = { x: e.clientX, y: e.clientY, alt: e.altKey };
    }, { passive: true });
    this.registerDomEvent(this.pane, "mouseleave", () => {
      this.pointer = null;
    });
    this.registerDomEvent(this.pane, "focusin", () => this.lookedAt());
    term.buffer.onBufferChange((buf) => {
      this.wheel.reset();
      this.cancelReports();
      if (buf.type === "normal" && !this.runningAgent) {
        this.readsKittyKeys = false;
        this.status?.programReturned();
      }
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) this.lookedAt();
      }),
    );
    this.term = term;
    this.applyPictures();

    this.observe();
    this.unhookMigrate = this.pane.onWindowMigrated(() => this.onMigrated());
    this.guardClose();
    try {
      this.controller?.mount?.({ top: this.top, stage: this.stage });
    } catch (e) {
      console.error(`${this.core.name}: the host's controls failed to draw`, e);
    }
    this.schedule();
  }

  protected override async onClose(): Promise<void> {
    this.core.liveViews.delete(this);
    this.keyQueue.clear();
    this.unguardClose?.();
    this.unguardClose = null;
    try {
      this.controller?.closed?.();
    } catch (e) {
      console.error(`${this.core.name}: the host's close failed`, e);
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.winFocus) this.winFocus.win.removeEventListener("focus", this.winFocus.fn);
    this.winFocus = null;
    this.cancelFrame();
    this.cancelReset();
    this.cancelReports();
    if (this.fitTimer) this.fitTimerWin?.clearTimeout(this.fitTimer);
    for (const t of this.toastTimers.values()) t.win.clearTimeout(t.id);
    this.toastTimers.clear();
    for (const t of this.cutTimers) t.win.clearTimeout(t.id);
    this.cutTimers.clear();
    this.fitTimer = 0;
    this.unhookMigrate?.();
    this.unhookMigrate = null;
    this.flushHeld(true);
    this.stopSession();
    if (this.hoverCheck) this.hoverCheckWin?.clearTimeout(this.hoverCheck);
    this.hoverCheck = 0;
    if (this.linksChanged) this.linksChangedWin?.clearTimeout(this.linksChanged);
    this.linksChanged = 0;
    this.picturesLayer?.dispose();
    this.picturesLayer = null;
    this.picturesDrain = null;
    this.retryNotice?.hide();
    this.retryNotice = null;
    this.term?.dispose();
    this.term = null;
    this.status = null;
    window.setTimeout(() => this.core.updateBadge(), 0);
  }

  private selectPrompt(): boolean {
    const term = this.term;
    if (!term) return false;
    this.promptSelection = null;
    const box = this.promptBox();
    const area = box && this.textArea(box);
    if (!box || !area) return false;
    const { top, bottom } = box;
    const start = area.x1;
    term.clearSelection();
    if (area.empty) return true;
    const last = area.last;
    const end = area.limits[last - area.first] ?? start;
    const length = (last - top - 1) * term.cols + end + 1 - start;
    if (term.modes.mouseTrackingMode !== "none" && this.dragInClaude(start, top + 1, end, last, bottom)) return true;
    term.select(start, top + 1, length);
    this.promptSelection = { text: term.getSelection(), indent: start, col: start, row: top + 1, length };
    return true;
  }

  private promptBox(): { top: number; bottom: number; mark: number } | null {
    const term = this.term;
    if (!term) return null;
    const buf = term.buffer.active;
    const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? "";
    const border = (y: number) => {
      const row = text(y);
      return /^\s*─{8,}/.test(row) && row.length >= term.cols - 2;
    };
    if (this.controller?.dialogShowing?.()) return null;
    const cursor = buf.baseY + buf.cursorY;
    let top = -1;
    let bottom = -1;
    for (let y = cursor; y >= Math.max(0, cursor - PROMPT_ROWS); y--) if (border(y)) { top = y; break; }
    for (let y = cursor; y < Math.min(buf.length, cursor + PROMPT_ROWS); y++) if (border(y)) { bottom = y; break; }
    if (top < 0 || bottom <= top + 1) return null;
    const first = buf.getLine(top + 1);
    if (!first) return null;
    const cell = buf.getNullCell();
    let mark = -1;
    for (let x = 0; x < term.cols && x < 4; x++) {
      if (first.getCell(x, cell)?.getChars() === "❯") { mark = x; break; }
    }
    if (mark < 0) return null;
    if (/^\s*❯\s*\d+\./.test(text(top + 1))) return null;
    return { top, bottom, mark };
  }

  private textArea(box: { top: number; bottom: number; mark: number }): TextArea | null {
    const term = this.term;
    if (!term) return null;
    const buf = term.buffer.active;
    const cell = buf.getNullCell();
    const first = buf.getLine(box.top + 1);
    if (!first) return null;
    const x1 = box.mark + 2;
    const lastCol = (y: number): number => {
      const line = buf.getLine(y);
      if (!line) return -1;
      for (let x = term.cols - 1; x >= (y === box.top + 1 ? x1 : 0); x--) {
        const c = line.getCell(x, cell);
        const ch = c?.getChars() ?? "";
        if (ch && ch.trim()) return x + Math.max(1, c?.getWidth() ?? 1) - 1;
      }
      return -1;
    };
    let last = box.bottom - 1;
    while (last > box.top + 1 && lastCol(last) < 0) last--;
    const col = lastCol(last);
    const empty = col < 0 || (last === box.top + 1 && !!first.getCell(x1, cell)?.isDim());
    const limits: number[] = [];
    for (let y = box.top + 1; y <= last; y++) {
      const end = Math.max(x1 - 1, lastCol(y));
      limits.push(Math.min(term.cols - 1, Math.max(x1, y < last ? end + 1 : end)));
    }
    return { first: box.top + 1, last, x1, cols: term.cols, limits, empty };
  }

  private cellAt(e: MouseEvent): Cell | null {
    const term = this.term;
    const size = term && cellSize(term);
    const rect = term?.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!term || !size || !rect) return null;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((e.clientX - rect.left) / size.width)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((e.clientY - rect.top) / size.height)));
    return { col, row: row + term.buffer.active.viewportY };
  }

  private inputSelected(): boolean {
    const term = this.term;
    if (!term || !this.isClaude() || this.controller?.dialogShowing?.()) return false;
    if (term.modes.mouseTrackingMode !== "none") return !!this.claudeSelection && !term.hasSelection();
    return !!this.promptSelection && term.hasSelection() && term.getSelection() === this.promptSelection.text;
  }

  private replaceSelection(after: string | null, gesture: Gesture | null): void {
    const term = this.term;
    if (!term || !this.session) return;
    const items: QueueItem[] = [];
    if (term.modes.mouseTrackingMode !== "none") {
      items.push("\x7f");
      items.push(gesture?.whole ? () => this.controller?.inputCleared?.() : () => this.controller?.inputEdited?.());
    } else if (this.promptSelection) {
      const rows = Math.ceil((this.promptSelection.col + this.promptSelection.length) / term.cols) + 1;
      items.push(...Array<string>(rows).fill("\x0b"), ...Array<string>(rows).fill("\x15"));
      items.push(() => this.controller?.inputCleared?.());
    }
    this.claudeSelection = null;
    this.promptSelection = null;
    term.clearSelection();
    if (after !== null) items.push(after);
    this.queue(items);
  }

  private queue(items: QueueItem[]): void {
    if (!this.keyQueue.busy) this.queueSession = this.session;
    this.keyQueue.push(...items);
  }

  private cutSelection(gesture: Gesture | null): void {
    const term = this.term;
    const hold = this.core.settings.programClipboard ? this.cutHold() : null;
    const waits = this.copy(gesture, hold?.copied);
    if (!term) return;
    if (term.modes.mouseTrackingMode === "none") {
      this.replaceSelection(null, null);
      return;
    }
    const queue = (items: QueueItem[]) => this.queue(waits && hold ? [{ hold: hold.hold, then: items }] : items);
    if (!gesture) return;
    const box = this.promptBox();
    if (gesture.top !== undefined && gesture.top !== box?.top) return;
    if (gesture.whole) {
      if (!box) return;
      const area = this.textArea(box);
      if (area && !area.empty) {
        const g = dragSelection({ col: area.limits[area.last - area.first] ?? area.x1, row: area.last }, { col: area.x1, row: area.first }, area.cols);
        const plan = replayPlan(g, this.lastPress, performance.now(), () => false);
        const items = this.reportItems(term, gestureReports(plan.gesture));
        if (items) {
          const keys = (g.keys ?? []).map((k) => SELECT_MOVE_KEYS[k]);
          queue([...(plan.wait > 0 ? [{ wait: plan.wait }] : []), ...items, ...keys, "\x7f", () => this.controller?.inputCleared?.()]);
          return;
        }
      }
      const rows = box.bottom - box.top;
      queue([...Array<string>(rows).fill("\x0b"), ...Array<string>(rows).fill("\x15"), () => this.controller?.inputCleared?.()]);
      return;
    }
    const line = term.buffer.active.getLine(gesture.to.row);
    const cell = term.buffer.active.getNullCell();
    const plan = replayPlan(gesture, this.lastPress, performance.now(), (col) => /^[\p{L}\p{N}_]$/u.test(line?.getCell(col, cell)?.getChars() ?? ""));
    const reports = gestureReports(plan.gesture);
    const wordDrag = gesture.clicks >= 2 && (gesture.from.col !== gesture.to.col || gesture.from.row !== gesture.to.row);
    if (wordDrag || !selectsInBox(gesture.from, gesture.to, gesture.clicks, box)) return;
    const items = this.reportItems(term, reports);
    if (!items) return;
    const keys = (gesture.keys ?? []).map((k) => SELECT_MOVE_KEYS[k]);
    queue([...(plan.wait > 0 ? [{ wait: plan.wait }] : []), ...items, ...keys, "\x7f", () => this.controller?.inputEdited?.()]);
  }

  private cutHold(): { copied: () => void; hold: QueueHold["hold"] } {
    let copied = false;
    let answer: ((go: boolean) => boolean) | null = null;
    return {
      copied: () => {
        copied = true;
        answer?.(true);
        answer = null;
      },
      hold: (done) => {
        if (copied) {
          done(true);
          return;
        }
        answer = done;
        const win = this.pane.win;
        const timer = {
          win,
          id: win.setTimeout(() => {
            this.cutTimers.delete(timer);
            if (answer !== done) return;
            answer = null;
            if (done(false) && this.term) this.showToast("Cut failed", `${this.getDisplayText()}'s copy didn't come, so the text was left in place.`, undefined, undefined, `${this.noticeKey}-cut`);
          }, COPY_UNWRAP_MS),
        };
        this.cutTimers.add(timer);
      },
    };
  }

  private reportItems(term: Terminal, reports: { at: Cell; action: "down" | "move" | "up" }[]): QueueItem[] | null {
    const size = cellSize(term);
    const top = term.buffer.active.viewportY;
    if (!size || reports.some((r) => r.at.row - top < 0 || r.at.row - top >= term.rows)) return null;
    return reports.map((r) => () => {
      if (this.term !== term || this.session !== this.queueSession) return;
      const row = r.at.row - top;
      const px = { x: Math.round((r.at.col + 0.5) * size.width), y: Math.round((row + 0.5) * size.height) };
      if (r.action === "down") this.lastPress = { ...r.at, at: performance.now() };
      this.queueWriting = true;
      try {
        sendButtonReport(term, r.at.col, row, r.action, px);
      } finally {
        this.queueWriting = false;
      }
    });
  }

  private extendSelection(move: SelectMove, gesture: Gesture | null): boolean {
    const term = this.term;
    if (!term || !this.session || term.modes.mouseTrackingMode === "none" || !this.isClaude() || this.controller?.dialogShowing?.() || term.hasSelection()) return false;
    const box = this.promptBox();
    const area = box && this.textArea(box);
    if (!area) return false;
    if (gesture && gesture.top !== undefined && gesture.top !== box?.top) {
      this.claudeSelection = null;
      return false;
    }
    if (gesture) {
      const focus = gestureFocus(gesture) ?? (gesture.focus === undefined ? this.clickFocus(gesture, area) : null);
      if (!focus) {
        if (move === "up" || move === "down") return false;
        this.claudeSelection = { ...gesture, whole: false, keys: [...(gesture.keys ?? []), move], focus: null };
        this.queue([SELECT_MOVE_KEYS[move]]);
        return true;
      }
      const target = textMove(focus, move, area);
      const moves = movesTo(focus, target, area.cols);
      if (!moves.length) return true;
      this.claudeSelection = gesture.clicks < 2 ? dragSelection(gesture.from, target, area.cols) : { ...gesture, whole: false, keys: [...(gesture.keys ?? []), ...moves], focus: target };
      this.queue(moves.map((m) => SELECT_MOVE_KEYS[m]));
      return true;
    }
    if (this.keyQueue.busy) return true;
    const buf = term.buffer.active;
    const caret = { col: buf.cursorX, row: buf.baseY + buf.cursorY };
    if (caret.row < area.first || caret.row > area.last || caret.col < area.x1) return false;
    const start = startSelection(move, caret, area);
    if (!start) return true;
    const items = this.reportItems(term, gestureReports(start));
    if (!items) return false;
    const wait = replayPlan(start, this.lastPress, performance.now(), () => false).wait;
    const release = items.pop();
    const keys = (start.keys ?? []).map((k) => SELECT_MOVE_KEYS[k]);
    const press = keys.length ? items.shift() : undefined;
    if (press) items.unshift(() => {
      this.holdOutput(performance.now() + SELECT_HOLD_MS);
      if (typeof press === "function") press();
    });
    items.push(() => {
      if (typeof release === "function") release();
      if (this.session && this.session === this.queueSession) for (const k of keys) this.sendNow(k);
      if (keys.length) this.holdOutput(performance.now() + SELECT_SETTLE_MS);
    });
    this.queue([...(wait > 0 ? [{ wait }] : []), ...items]);
    this.claudeSelection = start;
    return true;
  }

  private clickFocus(g: Gesture, area: TextArea): Cell | null {
    if (g.clicks >= 3) return { col: area.cols - 1, row: g.to.row };
    const line = this.term?.buffer.active.getLine(g.to.row);
    const cell = this.term?.buffer.active.getNullCell();
    const word = (col: number) => /^[\p{L}\p{N}_/.\-+~\\]$/u.test(line?.getCell(col, cell)?.getChars() ?? "");
    if (!word(g.to.col)) return null;
    let col = g.to.col;
    while (col < area.cols - 1 && word(col + 1)) col++;
    return { col, row: g.to.row };
  }

  private dragInClaude(col: number, row: number, endCol: number, endRow: number, below: number): boolean {
    const term = this.term;
    const cell = term && cellSize(term);
    if (!term || !cell) return false;
    const top = term.buffer.active.viewportY;
    const at = (c: number, r: number) => ({ col: c, row: r - top, px: { x: Math.round((c + 0.5) * cell.width), y: Math.round((r - top + 0.5) * cell.height) } });
    const from = at(col, row);
    const to = endCol + 1 < term.cols ? at(endCol + 1, endRow) : endRow + 1 < below ? at(0, endRow + 1) : at(term.cols - 1, endRow);
    if (from.row < 0 || to.row >= term.rows) return false;
    this.cancelPending();
    const session = this.session;
    if (sendButtonReport(term, from.col, from.row, "down", from.px) === null) return false;
    this.lastPress = { col: from.col, row: from.row + top, at: performance.now() };
    term.clearSelection();
    this.later(() => { if (this.term === term && this.session === session) sendButtonReport(term, to.col, to.row, "move", to.px); }, DRAG_STEP_MS);
    this.later(() => {
      if (this.term !== term || this.session !== session) return;
      sendButtonReport(term, to.col, to.row, "up", to.px);
      this.claudeSelection = { from: { col: from.col, row: from.row + top }, to: { col: to.col, row: to.row + top }, clicks: 1, whole: true };
    }, 2 * DRAG_STEP_MS);
    return true;
  }

  private later(fn: () => void, ms: number): void {
    const win = this.pane.win;
    const id = win.setTimeout(() => {
      this.pendingSends.delete(id);
      fn();
    }, ms);
    this.pendingSends.add(id);
  }

  private cancelPending(): void {
    for (const id of this.pendingSends) this.pane.win.clearTimeout(id);
    this.pendingSends.clear();
  }

  private copySelection(): void {
    const term = this.term;
    if (!term) return;
    let text = term.getSelection();
    const prompt = this.promptSelection;
    if (prompt && prompt.text === text) text = text.replace(new RegExp(`\n {1,${prompt.indent}}`, "g"), "\n");
    const copied = withoutPlaceholders(text);
    copyText(copied);
    this.saidCopied(copied, false);
  }

  private saidCopied(text: string, byProgram: boolean): void {
    const flat = text.replace(/\s+/g, " ").trim();
    const shown = flat.length > COPIED_SHOWN ? `${flat.slice(0, COPIED_SHOWN)}…` : flat;
    this.showToast(byProgram ? `${this.getDisplayText()} copied` : "Copied", shown || "(nothing)");
  }

  showToast(title: string, text: string, ms = noticeMs(), onClick?: () => void, key?: string, info = false): NotificationHandle {
    const el = this.term?.element;
    if (!el || (!key && !noticesOn())) return { hide: () => {}, shown: () => false };
    if (!this.toasts?.isConnected) this.toasts = el.createDiv({ cls: "vault-terminal-toasts xterm-hover" });
    const stack = this.toasts;
    const toast = createDiv({ cls: "vault-terminal-toast" });
    if (info) {
      toast.addClass("is-info");
      stack.insertBefore(toast, stack.querySelector(":scope > .is-copy"));
      const infos = stack.querySelectorAll(":scope > .is-info");
      for (let i = 0; i < infos.length - INFO_STACK; i++) this.dropToast(infos[i] as HTMLElement);
    } else if (key) {
      toast.dataset.key = key;
      for (const old of Array.from(stack.querySelectorAll<HTMLElement>(":scope > [data-key]"))) if (old.dataset.key === key) this.dropToast(old);
      stack.prepend(toast);
      const all = stack.querySelectorAll(":scope > [data-key]");
      for (let i = TOAST_STACK; i < all.length; i++) this.dropToast(all[i] as HTMLElement);
    } else {
      const copy = stack.querySelector<HTMLElement>(":scope > .is-copy");
      if (copy) this.dropToast(copy);
      toast.addClass("is-copy");
      stack.append(toast);
    }
    const clear = () => this.dropToast(toast);
    toast.addClass("is-clickable");
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "wheel"]) toast.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    toast.addEventListener("click", () => {
      clear();
      onClick?.();
    });
    addCloseX(toast, clear);
    toast.style.fontFamily = this.term?.options.fontFamily ?? "";
    toast.style.fontSize = `${this.term?.options.fontSize ?? 13}px`;
    toast.createDiv({ cls: "vault-terminal-toast-title", text: title });
    toast.createDiv({ cls: "vault-terminal-toast-text", text });
    if (ms) this.toastTimers.set(toast, { win: this.pane.win, id: this.pane.win.setTimeout(clear, ms) });
    return { hide: clear, shown: () => toast.isConnected };
  }

  private dropToast(toast: HTMLElement): void {
    const t = this.toastTimers.get(toast);
    if (t) t.win.clearTimeout(t.id);
    this.toastTimers.delete(toast);
    toast.remove();
  }

  get toastText(): string | null {
    return this.toasts?.isConnected && this.toasts.childElementCount ? (this.toasts.textContent ?? "") : null;
  }

  get terminal(): Terminal | null {
    return this.term;
  }

  get current(): HelperSession | null {
    return this.session;
  }

  get pictures(): PictureLayer | null {
    return this.picturesLayer;
  }

  applyPictures(): void {
    const term = this.term;
    if (!term) return;
    const on = this.core.settings.showPictures;
    if (on && !this.picturesLayer) {
      const drain = this.picturesDrain;
      this.picturesDrain = null;
      if (drain) drain.draining = false;
      this.picturesLayer = new PictureLayer(term, (text) => this.session?.write(text), drain ?? undefined);
    }
    if (!on && this.picturesLayer) {
      const layer = this.picturesLayer;
      this.picturesLayer = null;
      layer.dispose();
      const filter = layer.filter;
      const close = filter.closeLink();
      if (close) term.write(close);
      filter.draining = true;
      this.picturesDrain = filter.busy ? filter : null;
    }
  }

  override onResize(): void {
    this.schedule();
  }

  refreshLook(): void {
    if (!this.term || !this.opened) return;
    const look = readLook(this.contentEl);
    this.term.options.theme = look.theme;
    this.pane.style.setProperty("--vault-terminal-background", look.theme.background ?? "");
    const s = this.core.settings;
    this.term.options.fontFamily = s.fontFamily.trim() || look.fontFamily;
    this.term.options.fontSize = s.fontSize;
    this.term.options.letterSpacing = s.letterSpacing;
    this.term.options.lineHeight = s.lineHeight;
    this.applyCursor();
    if (this.term.options.scrollback !== s.scrollback) {
      this.term.options.scrollback = s.scrollback;
      this.picturesLayer?.bufferChanged();
    }
    this.applyOptionKey();
    this.updateHeader();
    this.schedule();
  }

  stopSession(withFallback = true): void {
    this.cancelPending();
    this.keyQueue.clear();
    this.claudeSelection = null;
    const s = this.session;
    this.session = null;
    if (!s) return;
    this.core.sessions.delete(s);
    s.close(withFallback);
    if (withFallback) {
      this.core.closing.add(s);
      s.child.once("exit", () => this.core.closing.delete(s));
      s.child.once("close", () => this.core.closing.delete(s));
    }
  }

  private observe(): void {
    this.observer?.disconnect();
    const win = this.pane.win as Window & typeof window;
    if (this.winFocus) this.winFocus.win.removeEventListener("focus", this.winFocus.fn);
    const fn = () => this.lookedAt();
    win.addEventListener("focus", fn);
    this.winFocus = { win, fn };
    this.observer = new win.ResizeObserver(() => this.layout());
    this.observer.observe(this.pane);
  }

  private onMigrated(): void {
    this.cancelFrame();
    this.flushHeld();
    this.keyQueue.clear();
    this.observe();
    this.anchor ??= this.topAnchor();
    if (this.term && this.opened) {
      this.term.open(this.pane);
      this.refreshLook();
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || !this.pane) return;
    const win = this.pane.win;
    this.frameWin = win;
    const run = () => {
      this.cancelFrame();
      this.layout();
    };
    this.frame = win.requestAnimationFrame(run);
    this.fallback = win.setTimeout(run, FRAME_FALLBACK_MS);
  }

  private cancelFrame(): void {
    if (this.frameWin) {
      if (this.frame) this.frameWin.cancelAnimationFrame(this.frame);
      if (this.fallback) this.frameWin.clearTimeout(this.fallback);
    }
    this.frame = 0;
    this.fallback = 0;
  }

  private layout(): void {
    const term = this.term;
    if (!term || !this.stateKnown) return;
    if (!this.showing()) {
      if (this.controller?.startHidden && !this.holdStart && !this.session && !this.starting && !this.ended) void (this.pending ? this.start(this.pending.kind, this.pending.folder, this.pending.opts) : this.start());
      return;
    }
    const el = this.pane;
    if (!this.opened) {
      term.open(el);
      this.opened = true;
      this.refreshLook();
    }
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.rows) || !Number.isFinite(dims.cols) || !validSize(dims.rows, dims.cols)) {
      if (this.retries++ < MEASURE_RETRIES) this.schedule();
      return;
    }
    this.retries = 0;
    if (this.bellMarked) this.lookedAt();
    if (this.session && (dims.rows !== term.rows || dims.cols !== term.cols)) {
      const now = performance.now();
      const wait = this.lastFitAt + RESIZE_SPACING_MS - now;
      if (wait > 0) {
        if (!this.fitTimer) {
          const win = this.pane.win;
          this.fitTimerWin = win;
          this.fitTimer = win.setTimeout(() => {
            this.fitTimer = 0;
            this.layout();
          }, wait);
        }
        return;
      }
      this.lastFitAt = now;
    }
    const anchor = this.anchor;
    this.anchor = null;
    if (dims.rows !== term.rows || dims.cols !== term.cols) {
      const top = anchor ?? this.topAnchor();
      this.fit.fit();
      this.restoreTop(top);
    } else if (anchor) {
      this.restoreTop(anchor);
    }
    if (this.session) this.session.resize(term.rows, term.cols, ...this.pixelSize());
    else if (!this.starting && !this.ended && !this.holdStart) void (this.pending ? this.start(this.pending.kind, this.pending.folder, this.pending.opts) : this.start());
  }

  private topAnchor(): TopAnchor | null {
    const term = this.term;
    const buf = term?.buffer.active;
    if (!term || !buf || buf.type !== "normal" || buf.viewportY >= buf.baseY) return null;
    let row = buf.viewportY;
    let rowsIn = 0;
    while (row > 0 && buf.getLine(row)?.isWrapped) {
      row--;
      rowsIn++;
    }
    const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return null;
    let fromEnd = 0;
    for (let y = buf.length - 1; y > row; y--) if (!buf.getLine(y)?.isWrapped) fromEnd++;
    return { marker, chars: rowsIn * term.cols, text: wholeLine(buf, row), fromEnd };
  }

  private anchorLine(anchor: TopAnchor): number {
    const buf = this.term!.buffer.active;
    const line = anchor.marker.line;
    const same = (y: number) => y >= 0 && !buf.getLine(y)?.isWrapped && wholeLine(buf, y) === anchor.text;
    if (same(line)) return line;
    let count = 0;
    for (let y = buf.length - 1; y >= 0; y--) {
      if (buf.getLine(y)?.isWrapped) continue;
      if (count === anchor.fromEnd) return same(y) ? y : line;
      count++;
    }
    return line;
  }

  private restoreTop(anchor: TopAnchor | null): void {
    const term = this.term;
    if (!anchor || !term) return;
    const line = this.anchorLine(anchor);
    anchor.marker.dispose();
    if (line < 0 || term.buffer.active.type !== "normal") return;
    const target = Math.min(line + Math.floor(anchor.chars / term.cols), term.buffer.active.baseY);
    const by = target - term.buffer.active.viewportY;
    if (by) scrollBuffer(term, by);
    else resyncViewport(term);
  }

  private noteReset(): void {
    const term = this.term;
    const buf = term?.buffer.active;
    if (!term || !buf || buf.type !== "normal") return;
    if (this.reset) {
      const reset = this.reset;
      reset.until = Date.now() + RESET_FOLLOW_MS;
      window.clearTimeout(reset.timer);
      reset.timer = window.setTimeout(() => this.followReset(true), RESET_FOLLOW_MS + 50);
      return;
    }
    if (buf.viewportY >= buf.baseY) return;
    const rows: string[] = [];
    for (let r = 0; r < Math.min(RESET_ROWS, term.rows); r++) rows.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? "");
    if (!rows.some((t) => t.trim())) rows.length = 0;
    const timer = window.setTimeout(() => this.followReset(true), RESET_FOLLOW_MS + 50);
    this.reset = { rows, from: buf.viewportY, until: Date.now() + RESET_FOLLOW_MS, timer, lastLook: 0, trailing: 0 };
  }

  private cancelReset(): void {
    if (!this.reset) return;
    window.clearTimeout(this.reset.timer);
    window.clearTimeout(this.reset.trailing);
    this.reset = null;
  }

  private followReset(final: boolean): void {
    const reset = this.reset;
    const term = this.term;
    if (!reset || !term) return;
    const now = Date.now();
    if (!final && now - reset.lastLook < 50) {
      reset.trailing ||= window.setTimeout(() => {
        if (this.reset === reset) reset.trailing = 0;
        this.followReset(false);
      }, 60);
      return;
    }
    reset.lastLook = now;
    const buf = term.buffer.active;
    let found = -1;
    if (buf.type === "normal" && reset.rows.length) {
      for (let i = 0; i + reset.rows.length <= buf.length; i++) {
        if (!reset.rows.every((t, k) => buf.getLine(i + k)?.translateToString(true) === t)) continue;
        if (found < 0 || Math.abs(i - reset.from) < Math.abs(found - reset.from)) found = i;
      }
      if (found > buf.baseY || (found === buf.baseY && !final)) found = -1;
    }
    if (found < 0 && !final && now < reset.until) return;
    window.clearTimeout(reset.timer);
    window.clearTimeout(reset.trailing);
    this.reset = null;
    if (buf.type !== "normal") return;
    const target = found >= 0 ? Math.min(found, buf.baseY) : buf.baseY;
    if (target !== buf.viewportY) scrollBuffer(term, target - buf.viewportY);
  }

  pixelSize(): [number, number] {
    const term = this.term;
    const cell = term ? cellSize(term) : null;
    return term && cell ? [term.cols * cell.width, term.rows * cell.height] : [0, 0];
  }

  private pixelSizeObject(): { width: number; height: number } {
    const [width, height] = this.pixelSize();
    return { width, height };
  }

  private showing(): boolean {
    const el = this.pane;
    return el.isConnected && el.isShown() && el.clientWidth > 0 && el.clientHeight > 0;
  }

  private async start(kind: TerminalKind = this.kind, folder = this.cwd, opts: StartOptions = {}): Promise<void> {
    const term = this.term;
    if (!term) return;
    this.flushHeld();
    this.starting = true;
    this.ended = false;
    this.beginSlowStart();
    try {
      const host = kind !== "shell" && this.controller?.launch ? await this.controller.launch(kind, !!opts.plain) : undefined;
      if (!this.term) return;
      if (host && "error" in host) {
        this.endSlowStart();
        this.pending = null;
        this.showProblem(host.error);
        this.ended = true;
        return;
      }
      const launch = await this.core.prepareLaunch(kind, folder, { ...opts, host, step: (what) => this.slowStep(what) });
      if (!this.term) return;
      if (!this.showing() && !this.controller?.startHidden) {
        this.pending = { kind, folder, opts };
        this.endSlowStart();
        return;
      }
      this.pending = null;
      if ("error" in launch) {
        this.endSlowStart();
        this.showProblem(launch.error);
        this.ended = true;
        this.controller?.launchFailed?.(launch.error);
        return;
      }
      this.unparsed = 0;
      this.paused = false;
      this.readsKittyKeys = false;
      this.runningAgent = kind === "shell" ? null : agentFor(kind, launch.program[0]);
      this.ranProgram = kind !== "shell";
      this.startDir = launch.cwd;
      this.currentDir = null;
      this.status = new StatusTracker(
        this.runningAgent?.reportsState ? "unknown" : "running",
        !!this.runningAgent?.reportsState,
        () => {
          this.noteState();
          this.updateHeader();
          this.core.updateBadge();
        },
        (a) => this.onAttention(a),
        (id, atStart) => this.onBridge(id, atStart),
      );
      this.status.start();
      this.foreground = null;
      this.recognized = null;
      this.shellStatus = null;
      this.launch = { kind, folder, added: launch.added, integration: launch.integration, plain: !!opts.plain, at: Date.now() };
      this.slowStep("starting the terminal's helper");
      const session = new HelperSession(
        { id: this.core.nextId(), ...launch, rows: term.rows, cols: term.cols, ...this.pixelSizeObject(), testDelay: this.core.test.helperDelay },
        {
          ready: (info) => {
            if (this.session !== session) return;
            this.endSlowStart();
            this.controller?.started?.(info.pid);
          },
          data: (chunk) => this.onOutput(chunk),
          foreground: (info) => this.onForeground(session, info),
          exit: (info) => this.onExit(session, info),
          error: (info) => this.onStartError(session, info),
        },
      );
      this.session = session;
      this.decoder = new TextDecoder("utf-8");
      this.core.sessions.add(session);
      if (opts.plain && this.retryNote) {
        this.explainRetry(session, this.retryNote);
        this.retryNote = null;
      }
      this.schedule();
    } finally {
      this.starting = false;
    }
  }

  private onKey(e: KeyboardEvent): boolean {
    const term = this.term;
    if (!term) return false;
    if (e.isComposing || e.key === "Process" || e.key === "Dead") {
      this.claudeSelection = null;
      return true;
    }
    const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.type !== "keydown") return !e.metaKey;
    if (!MODIFIER_KEYS.has(e.key)) {
      this.cancelReset();
      this.cancelPending();
    }
    const send = (data: string) => {
      e.preventDefault();
      this.onInput(data);
      return false;
    };
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "Escape" && plain && !e.shiftKey && term.hasSelection()) {
      e.preventDefault();
      term.clearSelection();
      return false;
    }
    const selected = !MODIFIER_KEYS.has(e.key) && this.inputSelected();
    const gesture = this.claudeSelection;
    const move = selectMove(e);
    if (move && this.extendSelection(move, gesture)) {
      e.preventDefault();
      return false;
    }
    const lineKey = e.metaKey ? e.key === "ArrowLeft" || e.key === "ArrowRight" : e.key === "Home" || e.key === "End";
    if (gesture && lineKey && e.shiftKey && !e.ctrlKey && !e.altKey && term.modes.mouseTrackingMode !== "none") {
      e.preventDefault();
      return false;
    }
    if (!MODIFIER_KEYS.has(e.key)) this.claudeSelection = null;
    if (selected && typesCharacter(e, !!term.options.macOptionIsMeta)) {
      e.preventDefault();
      this.replaceSelection(e.key, gesture);
      return false;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && plain && !e.shiftKey && selected) {
      e.preventDefault();
      this.replaceSelection(null, gesture);
      return false;
    }
    if ((e.key === "PageUp" || e.key === "PageDown") && plain) {
      const up = e.key === "PageUp";
      if (term.buffer.active.type === "normal" && !e.shiftKey) {
        e.preventDefault();
        scrollBuffer(term, (up ? -1 : 1) * Math.max(1, term.rows - 1));
        return false;
      }
      return send(up ? "\x1b[5~" : "\x1b[6~");
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (this.searchInput?.value) this.find(false);
      return false;
    }
    if (cmd && !e.shiftKey) {
      switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
        case "a":
          e.preventDefault();
          if (this.isClaude()) this.selectPrompt();
          return false;
        case "c":
          e.preventDefault();
          this.copy(selected ? gesture : null);
          return false;
        case "Delete":
          return send("\x0b");
        case "z":
          if (this.runningAgent && !this.runningAgent.undoKey) {
            e.preventDefault();
            return false;
          }
          return send("\x1f");
        case "Backspace":
          return send("\x15");
        case "v":
          if (this.agentKeys() && clipboardHasOnlyImage()) this.onInput("\x16");
          else if (selected && clipboardText()) this.replaceSelection(null, gesture);
          return false;
        case "x":
          e.preventDefault();
          if (selected) this.cutSelection(gesture);
          else this.copy();
          return false;
        case "f":
          e.preventDefault();
          this.openSearch();
          return false;
        case "g":
          e.preventDefault();
          if (this.searchInput?.value) this.find(true);
          return false;
        case "k":
          e.preventDefault();
          if (term.buffer.active.type === "normal") {
            term.clear();
            this.picturesLayer?.bufferChanged();
          }
          else if (this.isClaude()) this.onInput("\x0c");
          return false;
        case "ArrowLeft":
          return send("\x01");
        case "ArrowRight":
          return send("\x05");
        case "Home":
        case "End": {
          e.preventDefault();
          const buf = term.buffer.active;
          if (buf.type === "normal") scrollBuffer(term, (e.key === "Home" ? 0 : buf.baseY) - buf.viewportY);
          else this.onInput(e.key === "Home" ? "\x1b[1;5H" : "\x1b[1;5F");
          return false;
        }
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          this.jumpToPrompt(e.key === "ArrowUp" ? -1 : 1);
          return false;
      }
    }
    if (e.metaKey) return false;
    if (ctrlCCopies(e, term.hasSelection(), !!this.core.settings.ctrlCInterrupts)) {
      e.preventDefault();
      this.copySelection();
      return false;
    }
    if (e.key === "Tab" && e.ctrlKey && !e.altKey) return false;
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === "ArrowLeft") return send("\x1bb");
      if (e.key === "ArrowRight") return send("\x1bf");
      if (e.key === "Delete") return send("\x1bd");
    }
    if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey) return send("\x1b\r");
    return true;
  }

  private onWheel(e: WheelEvent): void {
    this.claudeSelection = null;
    const term = this.term;
    if (!term || !this.opened || e.ctrlKey || !this.ownWheel) return;
    const cell = cellSize(term);
    if (!cell) return;
    const mode = term.modes.mouseTrackingMode;
    const reports = mode === "vt200" || mode === "drag" || mode === "any";
    const buf = term.buffer.active;
    const lines = this.wheel.lines(e, cell.height, term.rows, scrollSpeed(this.core.settings.scrollSpeed));
    if (lines) this.cancelReset();
    if (reports) {
      const screen = term.element?.querySelector(".xterm-screen");
      const rect = screen?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : 0;
      const y = rect ? e.clientY - rect.top : 0;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(x / cell.width)));
      const row = Math.max(0, Math.min(term.rows - 1, Math.floor(y / cell.height)));
      const mods = { shift: e.shiftKey, alt: e.altKey, ctrl: false };
      this.reportAt = { col, row, mods, px: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } };
      this.reports.add(lines, term.rows);
      if (!this.sendReports()) return;
    } else if (buf.type === "alternate") {
      if (lines) {
        const arrow = `\x1b${term.modes.applicationCursorKeysMode ? "O" : "["}${lines < 0 ? "A" : "B"}`;
        this.onInput(arrow.repeat(Math.abs(lines)));
      }
    } else if (lines) {
      scrollBuffer(term, lines);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private sendReports(): boolean {
    const term = this.term;
    const at = this.reportAt;
    const mode = term?.modes.mouseTrackingMode;
    if (!term || !at || !(mode === "vt200" || mode === "drag" || mode === "any")) {
      this.cancelReports();
      return true;
    }
    const n = this.reports.take(performance.now());
    for (let i = 0; i < Math.abs(n); i++) {
      if (sendWheelReport(term, at.col, at.row, n < 0, at.mods, at.px) === null) {
        this.cancelReports();
        return false;
      }
    }
    if (this.reports.waiting && !this.reportFrame && this.pane) {
      const win = this.pane.win;
      this.reportWin = win;
      this.reportFrame = win.requestAnimationFrame(() => {
        this.reportFrame = 0;
        this.sendReports();
      });
    }
    return true;
  }

  private cancelReports(): void {
    this.reports.clear();
    if (this.reportFrame) this.reportWin?.cancelAnimationFrame(this.reportFrame);
    this.reportFrame = 0;
  }

  private copy(gesture: Gesture | null = null, copied?: () => void): boolean {
    const term = this.term;
    if (!term) return false;
    if (term.hasSelection()) this.copySelection();
    else if (this.programCopies()) {
      const breaks = gesture && this.selectionBreaks(gesture);
      const send = () => {
        this.copyBreaks.push({ breaks: breaks && { breaks: breaks.breaks, indent: breaks.indent }, at: performance.now(), copied });
        this.copyBreaks.splice(0, this.copyBreaks.length - 4);
        this.sendNow("\x1b[99;9u");
      };
      if (this.session && this.keyQueue.busy) this.keyQueue.push(send);
      else send();
      this.claudeSelection = null;
      return true;
    }
    return false;
  }

  private keepCopy(raw: string, text: string): void {
    const win = this.pane.win;
    const until = performance.now() + COPY_KEEP_MS;
    const check = () => {
      if (!this.term || performance.now() > until) return;
      const now = clipboardText();
      if (now === raw) copyText(text);
      else if (now === text) win.setTimeout(check, COPY_CHECK_MS);
    };
    win.setTimeout(check, COPY_CHECK_MS);
  }

  private selectionBreaks(g: Gesture): { breaks: string[]; indent: number; at: number } | null {
    const term = this.term;
    const box = this.promptBox();
    const area = box && this.textArea(box);
    if (!term || !area || term.modes.mouseTrackingMode === "none") return null;
    const ends = [g.from.row, g.to.row, gestureFocus(g)?.row ?? g.to.row];
    if (!g.whole && (Math.max(...ends) < area.first || Math.min(...ends) > area.last)) return null;
    const top = Math.max(area.first, g.whole ? area.first : Math.min(...ends));
    const bottom = Math.min(area.last, g.whole ? area.last : Math.max(...ends));
    const buf = term.buffer.active;
    const text = (y: number) => (buf.getLine(y)?.translateToString(true) ?? "").slice(y === area.first ? area.x1 : 0);
    const rows: InputRow[] = [];
    for (let y = top; y < bottom; y++) {
      const row = text(y).replace(/^ +/, "");
      const end = text(y).trimEnd().length - 1 + (y === area.first ? area.x1 : 0);
      rows.push({ end: Math.max(area.x1 - 1, end), nextWord: text(y + 1).trim().split(/\s/)[0]?.length ?? 0, oneWord: !/\s/.test(row.trim()) && end >= term.cols - 4 });
    }
    return { breaks: rowBreaks(rows, term.cols), indent: area.x1, at: performance.now() };
  }

  needsCloseConfirm(): boolean {
    return this.closeReason() !== null;
  }

  closeReason(): CloseReason | null {
    const own = this.terminalCloseReason();
    return this.controller?.closeReason ? this.controller.closeReason(own) : own;
  }

  terminalCloseReason(): CloseReason | null {
    const session = this.session;
    if (!session) return null;
    const state = this.status?.shown;
    const busy = state === "working" || state === "waiting";
    const background = !busy && !!this.status?.backgroundWork;
    const agentReason = (name: string): CloseReason | null => (busy ? { agent: true, name } : background ? { agent: true, name, background: true } : null);
    if (this.ranProgram) return this.runningAgent ? agentReason(this.runningAgent.name) : null;
    const others = this.processesNow(session);
    if (others === null) {
      const fg = this.foreground;
      const name = fg && fg.pgid !== session.programPid ? (this.recognized?.name ?? (fg.script || fg.name)) : `something (${this.core.name} couldn't check)`;
      return { agent: !!this.recognized, name };
    }
    const agentGroup = this.recognized && this.foreground ? this.foreground.pgid : -1;
    const rest = others.filter((p) => p.pgid !== agentGroup);
    if (rest.length) return { agent: false, name: (rest.find((p) => p.foreground) ?? rest[0]).name };
    if (this.recognized && others.length) return agentReason(this.recognized.name);
    return null;
  }

  private processesNow(session: HelperSession): { pid: number; pgid: number; foreground: boolean; name: string }[] | null {
    const tty = session.tty.replace(/^\/dev\//, "");
    if (!tty) return null;
    try {
      const out = execFileSync("/bin/ps", ["-t", tty, "-o", "pid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 2000 });
      const list: { pid: number; pgid: number; foreground: boolean; name: string }[] = [];
      const rows = out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
      const shellRow = rows.find((m) => Number(m[1]) === session.programPid);
      const shellGroup = shellRow?.[2];
      const shellName = (shellRow?.[4].split("/").pop() ?? "").replace(/^-/, "");
      const stillShell = !shellRow || shellName === session.programName || SHELLS.test(shellName);
      for (const m of rows) {
        const pid = Number(m[1]);
        if (m[3].startsWith("Z") || (stillShell && (pid === session.programPid || m[2] === shellGroup))) continue;
        list.push({ pid, pgid: Number(m[2]), foreground: m[3].includes("+"), name: m[4].split("/").pop() || m[4] });
      }
      return list;
    } catch (e) {
      if ((e as { status?: number }).status === 1) return [];
      return null;
    }
  }

  private foregroundName(): string {
    const fg = this.foreground;
    if (!fg || !this.session || fg.pgid === this.session.programPid) return "";
    return this.recognized?.name ?? (fg.script || fg.name);
  }

  get foregroundInfo(): { name: string; agent: string | null; at: number } {
    return { name: this.foregroundName(), agent: this.recognized?.id ?? null, at: this.foregroundAt };
  }

  private foregroundAt = 0;

  private onForeground(session: HelperSession, info: Foreground): void {
    if (this.session !== session) return;
    this.foreground = info;
    this.foregroundAt = Date.now();
    if (!this.ranProgram) {
      const agent = info.pgid === session.programPid ? null : agentForProgram(info.script || info.name);
      if (agent !== this.recognized) {
        if (this.recognized && this.shellStatus) {
          this.status = this.shellStatus;
          this.shellStatus = null;
          this.status.programReturned();
        }
        this.recognized = agent;
        this.runningAgent = agent;
        if (!agent) this.readsKittyKeys = false;
        if (agent) {
          this.shellStatus = this.status;
          this.status = new StatusTracker(
            agent.reportsState ? "unknown" : "running",
            agent.reportsState,
            () => {
              this.noteState();
              this.updateHeader();
              this.core.updateBadge();
            },
            (a) => this.onAttention(a),
            (id, atStart) => this.onBridge(id, atStart),
          );
          this.status.start();
          if (this.shellStatus) this.status.adopt(this.shellStatus);
        }
        this.core.updateBadge();
      }
    }
    this.updateHeader();
  }

  private guardClose(): void {
    const leaf = this.leaf as WorkspaceLeaf & { detach(): void };
    const own = Object.prototype.hasOwnProperty.call(leaf, "detach");
    const detach = leaf.detach.bind(leaf);
    this.unguardClose = () => {
      if (leaf.detach !== guarded) return;
      if (own) leaf.detach = detach;
      else delete (leaf as { detach?: () => void }).detach;
    };
    const guarded = () => {
      const why = this.core.closingAllowed || this.core.confirmedWindows.has(this.pane.win) ? null : this.closeReason();
      if (!why) return detach();
      const win = this.pane.win;
      const container = this.leaf.getContainer() as unknown as { close?: () => void };
      confirmClose(this.app, [why], () => {
        detach();
        if (win === window) return;
        window.setTimeout(() => {
          let left = 0;
          this.app.workspace.iterateAllLeaves((l) => {
            if (l.view.containerEl.win === win) left++;
          });
          if (left || win.closed) return;
          if (typeof container.close === "function") container.close();
          else win.close();
        }, 100);
      }, win);
    };
    leaf.detach = guarded;
  }

  private isClaude(): boolean {
    return this.runningAgent?.id === "claude" || this.claudeKeys();
  }

  private trackOption(e: KeyboardEvent): void {
    const term = this.term;
    if (!term || (e.code !== "AltLeft" && e.code !== "AltRight")) return;
    const down = e.type === "keydown";
    if (e.code === "AltRight") this.rightOption = down;
    else this.leftOption = down;
    this.applyOptionKey();
  }

  private rightOption = false;
  private leftOption = false;

  get optionIsMeta(): boolean {
    return !!this.term?.options.macOptionIsMeta;
  }

  applyOptionKey(): void {
    const term = this.term;
    if (!term) return;
    const mode = this.core.settings.optionKey;
    const meta = mode === "meta" || (mode === "right" && this.rightOption && !this.leftOption);
    if (term.options.macOptionIsMeta !== meta) term.options.macOptionIsMeta = meta;
  }

  private programCopies(): boolean {
    return !!this.term && this.agentKeys() && this.term.modes.mouseTrackingMode !== "none";
  }

  private pasteFromMenu(): void {
    const term = this.term;
    if (!term) return;
    this.claudeSelection = null;
    if (clipboardHasOnlyImage()) {
      if (this.agentKeys()) this.onInput("\x16");
      return;
    }
    const text = clipboardText();
    if (!text) return;
    this.cancelReset();
    term.paste(text);
  }

  private droppedPaths(e: DragEvent): string[] {
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      const p = filePath(f);
      if (p) paths.push(p);
    }
    if (paths.length) return paths;
    const drag = (this.app as unknown as { dragManager?: { draggable?: { type?: string; file?: { path: string }; files?: { path: string }[] } | null } }).dragManager?.draggable;
    const items = drag?.files ?? (drag?.file ? [drag.file] : []);
    for (const item of items) paths.push(this.core.absolutePath(item.path));
    return paths;
  }

  typePaths(paths: string[]): void {
    if (!this.term || !paths.length) return;
    this.cancelReset();
    this.term.paste(`${paths.map(shellQuote).join(" ")} `);
  }

  private showMenu(e: MouseEvent): void {
    if (!this.term) return;
    e.preventDefault();
    const items = [
      { title: "Copy", icon: "copy", disabled: !this.term.hasSelection() && !this.programCopies(), run: () => this.copy() },
      { title: "Paste", icon: "clipboard-paste", disabled: false, run: () => this.pasteFromMenu() },
      { title: "Select all", icon: "text-select", disabled: false, run: () => this.term?.selectAll() },
    ];
    const menu = new Menu();
    for (const item of items) menu.addItem((i) => i.setTitle(item.title).setIcon(item.icon).setDisabled(item.disabled).onClick(item.run));
    menu.showAtMouseEvent(e);
    this.lastMenu = { items, hide: () => menu.hide() };
  }

  private linkTip: HTMLElement | null = null;

  private showLinkTip(event: MouseEvent, address: string, textIsAddress: boolean, choose = false): void {
    const el = this.term?.element;
    if (!el) return;
    this.hideLinkTip();
    const tip = el.createDiv({ cls: "vault-terminal-link-tip xterm-hover" });
    const how = `${this.core.settings.linkClick === "click" && textIsAddress ? "Click" : "Cmd+click"} to ${choose ? "choose" : "open"}`;
    const target = this.core.obsidianTarget(address);
    if (target) tip.createDiv({ cls: "vault-terminal-link-tip-target", text: target.text });
    tip.createDiv({ cls: "vault-terminal-link-tip-address", text: address });
    tip.createDiv({ cls: "vault-terminal-link-tip-how", text: how });
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(event.clientX - r.left + 12, r.width - 320))}px`;
    const below = event.clientY - r.top + 18;
    const above = event.clientY - r.top - 8 - tip.offsetHeight;
    tip.style.top = `${Math.max(0, below + tip.offsetHeight > r.height && above >= 0 ? above : below)}px`;
    this.linkTip = tip;
  }

  private hideLinkTip(): void {
    this.linkTip?.remove();
    this.linkTip = null;
  }

  get linkTipText(): string | null {
    return this.linkTip?.isConnected ? this.linkTip.innerText || this.linkTip.textContent : null;
  }

  lastMenu: { items: { title: string; disabled: boolean; run: () => void }[]; hide(): void } | null = null;

  lastHotkey: { id: string | null; removed: boolean; ran: boolean } | null = null;

  private obsidianHotkey(e: KeyboardEvent): false {
    type Hotkey = { modifiers: string[]; key: string };
    const app = this.app as unknown as {
      commands: { commands: Record<string, unknown>; executeCommandById(id: string): boolean };
      hotkeyManager?: { getHotkeys(id: string): Hotkey[] | undefined; getDefaultHotkeys(id: string): Hotkey[] | undefined };
    };
    const want = e.shiftKey ? ["Ctrl", "Shift"] : ["Ctrl"];
    const same = (h: Hotkey) => h.key === "Tab" && h.modifiers.length === want.length && want.every((m) => h.modifiers.includes(m));
    let id: string | null = null;
    try {
      for (const cmd of Object.keys(app.commands.commands)) {
        const keys = app.hotkeyManager?.getHotkeys(cmd) ?? app.hotkeyManager?.getDefaultHotkeys(cmd) ?? [];
        if (keys.some(same)) {
          id = cmd;
          break;
        }
      }
    } catch {
      /* empty */
    }
    const fallback = e.shiftKey ? "workspace:previous-tab" : "workspace:next-tab";
    let removed = false;
    try {
      removed = !id && app.hotkeyManager?.getHotkeys(fallback) !== undefined;
    } catch {
      /* empty */
    }
    const ran = !removed && app.commands.executeCommandById(id ?? fallback);
    this.lastHotkey = { id, removed, ran };
    return false;
  }

  private afterRender(start: number, end: number): void {
    const term = this.term;
    if (!term) return;
    if (this.core.settings.markLinks) underlineLinks(term, this.linkColumns);
    else stopUnderliningLinks(term);
    const top = term.buffer.active.viewportY;
    for (let r = Math.max(0, start - JOINED_LINES); r <= Math.min(term.rows - 1, end + JOINED_LINES); r++) {
      if (r >= start && r <= end) continue;
      const drawn = this.linkRowsDrawn.get(top + r);
      if (drawn !== undefined && drawn !== this.linkColumnsOf(top + r).join(" ")) term.refresh(r, r);
    }
    this.restoreLinkHover();
  }

  private readonly linkColumns = (row: number): Array<[number, number]> => {
    const cols = this.linkColumnsOf(row);
    if (this.linkRowsDrawn.size >= LINK_ROWS_KEPT) for (const old of [...this.linkRowsDrawn.keys()].slice(0, LINK_ROWS_KEPT / 4)) this.linkRowsDrawn.delete(old);
    this.linkRowsDrawn.delete(row);
    this.linkRowsDrawn.set(row, cols.join(" "));
    return cols;
  };

  private linkColumnsOf(row: number): Array<[number, number]> {
    const term = this.term;
    if (!term || !this.core.settings.markLinks) return [];
    const y = row + 1;
    let links = this.linksThisRender.get(row);
    if (!links) {
      if (!this.linksThisRender.size) queueMicrotask(() => this.linksThisRender.clear());
      links = this.linksOn(y, true) ?? [];
      const buf = term.buffer.active;
      let first = row;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      for (let r = first; r === first || buf.getLine(r)?.isWrapped; r++) this.linksThisRender.set(r, links);
    }
    const out: Array<[number, number]> = [];
    for (const { range } of links) {
      if (range.start.y > y || range.end.y < y) continue;
      out.push([range.start.y === y ? range.start.x - 1 : 0, range.end.y === y ? range.end.x - 1 : term.cols - 1]);
    }
    return out;
  }

  refreshLinks(): void {
    if (!this.term) return;
    const win = this.pane.win;
    if (this.linksChanged && this.linksChangedWin === win) return;
    if (this.linksChanged) this.linksChangedWin?.clearTimeout(this.linksChanged);
    this.linksChangedWin = win;
    this.linksChanged = win.setTimeout(this.guarded(undefined, () => {
      this.linksChanged = 0;
      this.pathsKept.clear();
      this.term?.refresh(0, this.term.rows - 1);
    }), LINKS_CHANGED_MS);
  }

  private restoreLinkHover(): void {
    if (!this.pointer) return;
    const win = this.pane.win;
    if (this.hoverCheck && this.hoverCheckWin === win) return;
    if (this.hoverCheck) this.hoverCheckWin?.clearTimeout(this.hoverCheck);
    this.hoverCheckWin = win;
    this.hoverCheck = win.setTimeout(this.guarded(undefined, () => {
      this.hoverCheck = 0;
      const term = this.term;
      const p = this.pointer;
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      const cell = term && cellSize(term);
      if (!term || !p || !screen || !cell || screen.classList.contains("xterm-cursor-pointer")) return;
      const box = screen.getBoundingClientRect();
      const col = Math.floor((p.x - box.left) / cell.width);
      const row = Math.floor((p.y - box.top) / cell.height);
      if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return;
      const y = term.buffer.active.viewportY + row + 1;
      const at = y * term.cols + col + 1;
      const over = (this.linksOn(y) ?? []).some(({ range }) => at >= range.start.y * term.cols + range.start.x && at <= range.end.y * term.cols + range.end.x);
      if (!over) return;
      const away = row > 0 ? -cell.height : cell.height;
      screen.dispatchEvent(new MouseEvent("mousemove", { bubbles: false, clientX: p.x, clientY: p.y + away, altKey: p.alt }));
      screen.dispatchEvent(new MouseEvent("mousemove", { bubbles: false, clientX: p.x, clientY: p.y, altKey: p.alt }));
    }), 0);
  }

  private linksOn(y: number, whole = false): ILink[] | undefined {
    const term = this.term;
    const buf = term?.buffer.active;
    if (!term || !buf?.getLine(y - 1)) return undefined;
    const lineAt = (row: number): { first: number; last: number } => {
      let first = row;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      let last = row;
      while (buf.getLine(last + 1)?.isWrapped) last++;
      return { first, last };
    };
    const rowCells = (row: number): RowCells => cellsOf(buf.getLine(row)!);
    const lines = [lineAt(y - 1)];
    for (let k = 0; k < JOINED_LINES; k++) {
      const top = lines[0];
      if (top.first === 0) break;
      const above = lineAt(top.first - 1);
      if (!cliWrapped(rowCells(above.last), rowCells(top.first), term.cols)) break;
      lines.unshift(above);
    }
    for (let k = 0; k < JOINED_LINES; k++) {
      const bottom = lines[lines.length - 1];
      if (!buf.getLine(bottom.last + 1)) break;
      const below = lineAt(bottom.last + 1);
      if (!cliWrapped(rowCells(bottom.last), rowCells(below.first), term.cols)) break;
      lines.push(below);
    }
    let text = "";
    const cells: ({ x: number; y: number } | null)[] = [];
    const edges = new Set<number>();
    let lastCell: { x: number; y: number } | undefined;
    lines.forEach((line, i) => {
      let part = "";
      const partCells: { x: number; y: number }[] = [];
      for (let row = line.first; row <= line.last; row++) {
        const got = cellsOf(buf.getLine(row)!);
        part += got.text;
        for (const x of got.columns) partCells.push({ x: x + 1, y: row + 1 });
      }
      if (i > 0) {
        const indent = part.length - part.trimStart().length;
        part = part.slice(indent);
        partCells.splice(0, indent);
        if (lastCell?.x === term.cols) edges.add(text.length);
        text += " ";
        cells.push(null);
      }
      if (i < lines.length - 1) {
        part = part.trimEnd();
        partCells.length = part.length;
      }
      text += part;
      for (const cell of partCells) cells.push(cell);
      lastCell = partCells[partCells.length - 1];
    });
    const rangesOf = (start: number, end: number): IBufferRange[] => {
      const out: IBufferRange[] = [];
      let open = false;
      for (let i = start; i < end; i++) {
        const cell = cells[i];
        if (!cell) open = false;
        else if (open) out[out.length - 1].end = cell;
        else {
          out.push({ start: cell, end: cell });
          open = true;
        }
      }
      return out;
    };
    const chosen = findUrlsAcross(text, edges, (long, short) => this.core.obsidianTarget(long)?.found === false && this.core.obsidianTarget(short)?.found === true);
    const urls = chosen.flatMap((l) =>
      rangesOf(l.start, l.end).map(
        (range): ILink => ({
          text: l.url,
          range,
          activate: (event, url) => {
            if (this.core.opensLink(event)) this.openUri(url);
          },
          hover: (event, url) => this.showLinkTip(event, url, true),
          leave: () => this.hideLinkTip(),
        }),
      ),
    );
    const now = Date.now();
    const key = `${this.folder}\0${text}`;
    const kept = this.pathsKept.get(key);
    let found = kept && now - kept.at < PATHS_KEPT_MS ? kept.found : null;
    if (!found) {
      found = findPaths(text, (p) => exists(this.resolve(p)) || this.core.vaultNotes(p).length > 0);
      if (this.pathsKept.size >= PATHS_KEPT_MAX) this.pathsKept.clear();
      this.pathsKept.set(key, { at: now, found });
    }
    const paths = found.flatMap((l) =>
      rangesOf(l.start, l.end).map(
        (range): ILink => ({
          text: l.path,
          range,
          hover: (event) => {
            const abs = this.resolve(l.path);
            if (exists(abs)) return this.showLinkTip(event, abs, true);
            const notes = this.core.vaultNotes(l.path);
            if (notes.length > 1) this.showLinkTip(event, `${notes.length} files named ${notes[0].name}`, true, true);
            else this.showLinkTip(event, notes[0]?.path ?? l.path, true);
          },
          leave: () => this.hideLinkTip(),
          activate: (event) => {
            if (!this.core.opensLink(event)) return;
            const line = Number(text.slice(l.end).match(/^:(\d+)/)?.[1] ?? 0) || undefined;
            const abs = this.resolve(l.path);
            if (exists(abs)) this.core.openPath(abs, line);
            else this.core.openNotes(this.core.vaultNotes(l.path), line);
          },
        }),
      ),
    );
    const links = whole ? [...urls, ...paths] : [...urls, ...paths].filter((l) => l.range.start.y <= y && l.range.end.y >= y);
    return links.length ? links : undefined;
  }

  private resolve(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return isAbsolute(p) ? p : join(this.folder, p);
  }

  private jumpToPrompt(direction: -1 | 1): void {
    const term = this.term;
    if (!term || term.buffer.active.type !== "normal") return;
    this.cancelReset();
    const top = term.buffer.active.viewportY;
    const lines = this.promptMarks.map((m) => m.line).filter((l) => l >= 0);
    const target = direction < 0 ? lines.filter((l) => l < top).pop() : lines.find((l) => l > top);
    if (target === undefined) {
      if (direction > 0) term.scrollToBottom();
      return;
    }
    term.scrollToLine(target);
  }

  text(): string {
    const term = this.term;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const t = line.translateToString(!buf.getLine(i + 1)?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += t;
      else lines.push(t);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return withoutPlaceholders(lines.join("\n"));
  }

  private textIn(range: { start: { x: number; y: number }; end: { x: number; y: number } }): string {
    const buf = this.term?.buffer.active;
    if (!buf) return "";
    let text = "";
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = buf.getLine(y - 1);
      if (!line) continue;
      const from = y === range.start.y ? range.start.x - 1 : 0;
      const to = y === range.end.y ? range.end.x : undefined;
      text += line.translateToString(false, from, to);
    }
    return text;
  }

  private openUri(uri: string): void {
    if (/^https?:\/\//i.test(uri)) this.core.openUrl(uri);
    else if (/^obsidian:\/\//i.test(uri)) this.core.openObsidianUri(uri);
    else if (/^file:\/\//i.test(uri)) {
      try {
        this.core.openPath(fileURLToPath(uri));
      } catch {
        /* empty */
      }
    }
  }

  private openSearch(): void {
    if (!this.searchBar) {
      const bar = this.stage.createDiv({ cls: "vault-terminal-search" });
      const input = bar.createEl("input", { type: "search", attr: { placeholder: "Find", "aria-label": "Find in terminal", spellcheck: "false" } });
      const count = bar.createSpan({ cls: "vault-terminal-search-count" });
      const button = (icon: string, label: string, fn: () => void) => {
        const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
        setIcon(b, icon);
        b.addEventListener("click", fn);
      };
      button("chevron-up", "Previous match", () => this.find(false));
      button("chevron-down", "Next match", () => this.find(true));
      button("x", "Close", () => this.closeSearch());
      input.addEventListener("input", () => this.find(true, true));
      bar.addEventListener("keydown", (e) => {
        if (e.isComposing || e.key === "Process" || e.key === "Dead") return;
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeSearch();
        } else if (e.key === "Enter" && e.target === input) {
          e.preventDefault();
          this.find(!e.shiftKey);
        } else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "g") {
          e.preventDefault();
          this.find(!e.shiftKey);
        }
      });
      this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
        count.setText(!input.value ? "" : resultCount ? `${resultIndex + 1} of ${resultCount}` : "No matches");
      });
      this.searchBar = bar;
      this.searchInput = input;
      this.searchCount = count;
    }
    this.searchBar.show();
    const selected = this.term?.getSelection();
    if (selected && !selected.includes("\n")) this.searchInput!.value = selected;
    this.searchInput!.focus();
    this.searchInput!.select();
  }

  private find(forward: boolean, incremental = false): void {
    const q = this.searchInput?.value ?? "";
    if (!q) {
      this.search.clearDecorations();
      this.searchCount?.setText("");
      return;
    }
    const options: ISearchOptions = {
      incremental,
      decorations: {
        matchBackground: "#7a6a1e",
        matchOverviewRuler: "#c9a227",
        activeMatchBackground: "#d08c1a",
        activeMatchColorOverviewRuler: "#ff9d00",
      },
    };
    const pattern = findPattern(q);
    if (pattern) options.regex = true;
    if (forward) this.search.findNext(pattern ?? q, options);
    else this.search.findPrevious(pattern ?? q, options);
  }

  private closeSearch(): void {
    this.search.clearDecorations();
    this.searchBar?.hide();
    this.term?.focus();
  }

  get searchState(): { open: boolean; count: string } {
    return { open: !!this.searchBar?.isShown(), count: this.searchCount?.getText() ?? "" };
  }

  private onInput(data: string): void {
    if (this.session && this.keyQueue.busy && !this.queueWriting) {
      this.keyQueue.push(data);
      return;
    }
    this.sendNow(data);
  }

  private sendNow(data: string): void {
    if (this.session) {
      if (data.includes("\r")) this.status?.answered();
      else if (data === "\x1b") this.status?.escaped();
      this.session.write(data);
      this.controller?.input?.(data);
    } else if (this.ended && !this.starting) {
      const what = afterExitKey(data, !!this.controller);
      if (what === "restart") {
        if (this.controller?.restart) this.controller.restart();
        else void this.start(this.kind);
      } else if (what === "shell") void this.start("shell");
    }
  }

  private holdOutput(until: number): void {
    this.outputHeldUntil = until;
    if (this.heldOutput.length) this.scheduleHeld();
  }
  private scheduleHeld(): void {
    if (this.heldTimer) this.heldTimerWin?.clearTimeout(this.heldTimer);
    const win = this.pane.win;
    this.heldTimerWin = win;
    this.heldTimer = win.setTimeout(() => {
      this.heldTimer = 0;
      this.flushHeld();
    }, Math.max(1, this.outputHeldUntil - performance.now()));
  }
  private flushHeld(drop = false): void {
    if (this.heldTimer) this.heldTimerWin?.clearTimeout(this.heldTimer);
    this.heldTimer = 0;
    this.outputHeldUntil = 0;
    const held = this.heldOutput;
    this.heldOutput = [];
    if (drop || !held.length) return;
    const all = new Uint8Array(held.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of held) {
      all.set(c, at);
      at += c.length;
    }
    this.onOutput(all);
  }
  private outputHeldUntil = 0;
  private heldOutput: Uint8Array[] = [];
  private heldTimer = 0;
  private heldTimerWin: Window | null = null;

  private onOutput(chunk: Uint8Array): void {
    const term = this.term;
    if (!term) return;
    if (this.outputHeldUntil > performance.now()) {
      this.heldOutput.push(chunk);
      if (!this.heldTimer) this.scheduleHeld();
      return;
    }
    if (this.heldOutput.length) this.flushHeld();
    if (this.slow) this.endSlowStart();
    const size = chunk.length;
    this.unparsed += size;
    const parsed = () => {
      this.unparsed -= size;
      if (this.paused && this.unparsed < OUTPUT_LOW) {
        this.paused = false;
        this.session?.resume();
      }
    };
    if (this.controller?.output && this.decoder) {
      try {
        this.controller.output(this.decoder.decode(chunk, { stream: true }));
      } catch (e) {
        console.error(`${this.core.name}: the host's output handler failed`, e);
      }
    }
    const layer = this.picturesLayer;
    const drain = this.picturesDrain;
    if (layer) layer.write(chunk, parsed);
    else if (drain) {
      for (const piece of drain.push(chunk)) if (piece.kind === "text") term.write(piece.bytes);
      term.write("", parsed);
      if (!drain.busy) this.picturesDrain = null;
    } else term.write(chunk, parsed);
    if (!this.paused && this.unparsed > OUTPUT_HIGH) {
      this.paused = true;
      this.session?.pause();
    }
  }

  lastExit: { info: ExitInfo; helper: string; ranFor: number } | null = null;

  private onExit(session: HelperSession, info: ExitInfo): void {
    if (this.session === session) this.lastExit = { info, helper: session.diagnostics.slice(-600), ranFor: this.launch ? Date.now() - this.launch.at : -1 };
    if (this.session !== session) return;
    this.flushHeld();
    this.endSlowStart();
    this.core.sessions.delete(session);
    this.session = null;
    this.ended = true;
    this.status?.exit();
    if (this.controller?.exit?.(info)) return;
    const l = this.launch;
    if (l && this.ranProgram && l.added.length && !l.plain && typeof info.code === "number" && info.code !== 0 && info.code < 128 && !info.closed && (info.ran !== undefined ? info.ran * 1000 : Date.now() - l.at) < RETRY_WITHIN_MS) {
      this.retryPlain(l);
      return;
    }
    const how = info.signal ? `was ended by signal ${info.signal}` : `exited with code ${info.code ?? "unknown"}`;
    const agent = agentById(this.kind);
    const name = agent?.name ?? "The program";
    if (agent && this.core.settings.shellAfterExit && this.ranProgram && !this.controller) {
      this.resetModes(`\r\n\x1b[2m[${name} ${how}. A shell in the same folder:]\x1b[0m\r\n`);
      void this.start("shell", this.startDir);
      return;
    }
    const next = this.controller ? (this.controller.exitHint?.() ?? "Press Enter to start it again.") : agent ? `Press Enter to start ${agent.name} again, or S for a shell.` : "Press Enter to start it again.";
    this.resetModes(`\r\n\x1b[2m[${name} ${how}. ${next}]\x1b[0m\r\n`);
  }

  private onStartError(session: HelperSession, info: StartError): void {
    if (this.session !== session) return;
    this.endSlowStart();
    this.core.sessions.delete(session);
    this.session = null;
    this.ended = true;
    this.status?.exit();
    let message = info.message;
    if (info.kind === "spawn") message = `Couldn't start ${info.program ?? "the program"}: ${info.message}.`;
    else if (info.kind === "python") {
      this.core.forgetPython();
      message = `Couldn't run Python at ${info.program}: ${info.message}.`;
    }
    this.showProblem(message);
    this.controller?.launchFailed?.(message);
  }

  private updateHeader(): void {
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  looking(): boolean {
    return !!this.pane && this.pane.isShown() && this.pane.doc.hasFocus();
  }

  private lookedAt(): void {
    if (!this.bellMarked || !this.looking()) return;
    this.bellMarked = false;
    this.updateHeader();
  }

  private onBell(): void {
    if (this.core.settings.bellSound) playBell(this.pane.win);
    if (this.looking() || this.bellMarked) return;
    this.bellMarked = true;
    this.updateHeader();
  }

  readonly stateLog: { state: string; at: number }[] = [];
  readonly attentionLog: { how: string; at: number }[] = [];

  private noteState(): void {
    const state = this.status?.shown;
    if (state && this.stateLog[this.stateLog.length - 1]?.state !== state) {
      this.stateLog.push({ state, at: Date.now() });
      try {
        this.controller?.stateChange?.(state);
      } catch (e) {
        console.error(`${this.core.name}: the host's state handler failed`, e);
      }
    }
    if (this.stateLog.length > 200) this.stateLog.splice(0, 100);
  }

  private onBridge(id: string, atStart: boolean): void {
    try {
      this.controller?.bridge?.(id, atStart);
    } catch (e) {
      console.error(`${this.core.name}: the host's Remote Control handler failed`, e);
    }
  }

  private onAttention(a: Attention): void {
    if (a.quiet) {
      this.showToast(this.getDisplayText(), a.body);
      return;
    }
    if (this.controller?.notifiesItself?.()) return;
    const s = this.core.settings;
    const looking = this.looking();
    if ((!a.needs && s.finishedTo === "none") || (s.hideLooking && looking)) return;
    const text = a.body || a.title;
    const name = this.getDisplayText();
    const to = a.needs ? s.needsYouTo : s.finishedTo;
    const how = [toDesktop(to) && "notification", toObsidian(to) && (looking ? "toast" : "notice")].filter(Boolean).join("+");
    this.attentionLog.push({ how: how || "none", at: Date.now() });
    if (this.attentionLog.length > 200) this.attentionLog.splice(0, 100);
    this.core.notify(a.title || name, a.title && a.title !== name ? `${name}: ${text}` : text, () => this.bringForward(), this.noticeKey, a.needs ? "needs" : "finished");
  }

  private claudeKeys(): boolean {
    const term = this.term;
    if (!term || !this.readsKittyKeys || !this.status?.asksStatus) return false;
    return this.runningAgent?.id === "claude" || term.buffer.active.type === "alternate";
  }

  private agentKeys(): boolean {
    return this.claudeKeys() || !!this.runningAgent?.agentKeys;
  }

  get readsAgentKeys(): boolean {
    return this.agentKeys();
  }

  bringForward(): void {
    this.core.activateApp();
    this.pane.win.focus();
    void this.app.workspace.revealLeaf(this.leaf);
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    this.term?.focus();
  }

  private resetModes(then: string): void {
    const term = this.term;
    if (!term) return;
    term.write("", () => {
      if (this.term !== term) return;
      const leave = term.buffer.active.type === "alternate" ? "\x1b[?1049l" : "";
      term.write(`${leave}\x1b[!p\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b>\x1b[0m${then}`);
    });
  }

  private beginSlowStart(): void {
    this.endSlowStart();
    const slow = { timer: 0, step: "starting", shown: false };
    slow.timer = window.setTimeout(() => {
      if (this.slow !== slow || !this.term) return;
      slow.shown = true;
      const fresh = this.term.buffer.active.cursorX > 0 ? "\r\n" : "";
      this.term.write(`${fresh}\x1b[2m${this.slowLine(slow.step)}\x1b[0m`);
    }, SLOW_START_MS);
    this.slow = slow;
  }

  private slowStep(what: string): void {
    const slow = this.slow;
    if (!slow) return;
    slow.step = what;
    if (slow.shown) this.term?.write(`\r\x1b[2K\x1b[2m${this.slowLine(what)}\x1b[0m`);
  }

  private slowLine(step: string): string {
    const text = `[Still starting: ${step}…]`;
    const room = Math.max(4, (this.term?.cols ?? 80) - 1);
    return text.length <= room ? text : `${text.slice(0, room - 2)}…]`;
  }

  private endSlowStart(): void {
    const slow = this.slow;
    if (!slow) return;
    window.clearTimeout(slow.timer);
    this.slow = null;
    if (slow.shown) this.term?.write("\r\x1b[2K");
  }

  get slowStartShown(): string | null {
    return this.slow?.shown ? this.slow.step : null;
  }

  private integrationFailed(): void {
    const l = this.launch;
    if (!this.session || !l?.integration || this.ranProgram) return;
    this.stopSession();
    this.ended = false;
    void this.start("shell", l.folder, { noIntegration: true }).then(() => {
      this.term?.write("\x1b[2m[Shell integration failed to start, so this terminal runs without it.]\x1b[0m\r\n");
    });
  }

  lastRetry: { why: string; line: boolean; notice: boolean } | null = null;

  private retryPlain(l: NonNullable<TerminalView["launch"]>): void {
    this.resetModes("");
    this.lastRetry = { why: `exited at once with ${l.added.join(", ")}`, line: false, notice: false };
    this.retryNote = l.added;
    void this.start(l.kind, l.folder, { plain: true });
  }

  retryNotice: NotificationHandle | null = null;

  private retryNote: string[] | null = null;

  private explainRetry(second: HelperSession, added: string[]): void {
    window.setTimeout(() => {
      if (this.session !== second || !second.running || !this.term) return;
      const text = `Started without what ${this.core.name} adds (${added.join(", ")}): the first start ended at once.`;
      if (this.term.buffer.active.type === "normal") {
        this.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
        if (this.lastRetry) this.lastRetry.line = true;
      } else {
        this.retryNotice?.hide();
        this.retryNotice = this.core.notify(this.getDisplayText(), `${text} Its tab state, notifications and pictures are off in this session.`, () => this.bringForward(), this.noticeKey, "info");
        if (this.lastRetry) this.lastRetry.notice = true;
      }
    }, RETRY_WITHIN_MS);
  }

  releaseStart(): void {
    if (!this.holdStart) return;
    this.holdStart = false;
    this.schedule();
  }

  restart(): void {
    if (this.session || this.starting) return;
    this.ended = false;
    this.pending = null;
    void this.start(this.kind);
  }

  get running(): boolean {
    return !!this.session?.running;
  }

  get programPid(): number {
    return this.session?.programPid ?? 0;
  }

  write(data: string): boolean {
    if (!this.session) return false;
    this.cancelReset();
    this.session.write(data);
    return true;
  }

  get bracketedPaste(): boolean {
    return !!this.term?.modes.bracketedPasteMode;
  }

  paste(text: string): void {
    if (!this.term || !text) return;
    this.cancelReset();
    if (!this.opened) {
      const body = text.replace(/\r?\n/g, "\r");
      this.term.input(this.term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body, true);
      return;
    }
    this.term.paste(text);
  }

  focus(): void {
    this.term?.focus();
  }

  inputLooksEmpty(): boolean | null {
    const term = this.term;
    if (!term || !this.isClaude() || this.keyQueue.busy || this.unparsed > 0 || this.heldOutput.length) return null;
    const box = this.promptBox();
    if (!box) return null;
    const buf = term.buffer.active;
    const cell = buf.getNullCell();
    for (let y = box.top + 1; y < box.bottom; y++) {
      const line = buf.getLine(y);
      if (!line) return null;
      for (let x = y === box.top + 1 ? box.mark + 1 : 0; x < term.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c) return null;
        if (c.getChars().trim() && !c.isDim()) return false;
      }
    }
    return true;
  }

  get screenRows(): number {
    return this.term?.rows ?? 0;
  }

  screenTail(rows = 40): string {
    const term = this.term;
    const buf = term?.buffer.active;
    if (!term || !buf) return "";
    const end = buf.baseY + term.rows;
    const out: string[] = [];
    for (let y = Math.max(0, end - rows); y < end; y++) {
      const line = buf.getLine(y);
      if (line) out.push(line.translateToString(true));
    }
    return withoutPlaceholders(out.join("\n"));
  }

  get selection(): string {
    return this.term?.hasSelection() ? withoutPlaceholders(this.term.getSelection()) : "";
  }

  refreshHeader(): void {
    this.updateHeader();
  }

  get programTitle(): string {
    return this.status?.title ?? "";
  }

  get state(): ProgramState | null {
    return this.status?.shown ?? null;
  }

  get backgroundWork(): boolean {
    return !!this.status?.backgroundWork;
  }

  print(text: string): void {
    const term = this.term;
    if (!term) return;
    const fresh = term.buffer.active.cursorX > 0 ? "\r\n" : "";
    term.write(`${fresh}\x1b[2m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`);
  }

  private showProblem(message: string): void {
    const text = message.replace(/\r?\n/g, "\r\n");
    this.resetModes(`\r\n\x1b[31m${text}\x1b[0m\r\n\r\n\x1b[2m[Press Enter to try again.]\x1b[0m\r\n`);
  }
}

function filePath(file: File): string {
  try {
    const electron = (window as unknown as { require(m: string): { webUtils?: { getPathForFile(f: File): string } } }).require("electron");
    const p = electron.webUtils?.getPathForFile(file);
    if (p) return p;
  } catch {
    /* empty */
  }
  return (file as File & { path?: string }).path ?? "";
}

function wholeLine(buf: IBuffer, y: number): string {
  let text = "";
  const cell = buf.getNullCell();
  for (let r = y; r < buf.length; r++) {
    const line = buf.getLine(r);
    if (!line || (r > y && !line.isWrapped)) break;
    let end = line.length;
    while (end > 0 && line.getCell(end - 1, cell)?.getChars() === "") end--;
    text += line.translateToString(false, 0, end);
  }
  return text.trimEnd();
}

export function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

function isThisMac(host: string): boolean {
  const h = host.toLowerCase();
  const me = hostname().toLowerCase();
  return !h || h === "localhost" || h === me || h === me.replace(/\.local$/, "") || `${h}.local` === me;
}

const AUTOMOUNTS = new Set(["/net", "/home", "/Network", "/System/Volumes/Data/home", "/System/Volumes/Data/Network"]);

export function noteAutomounts(paths: string[]): void {
  for (const p of paths) if (p.startsWith("/") && p !== "/") AUTOMOUNTS.add(p.replace(/\/+$/, ""));
}

export function underAutomount(path: string): boolean {
  const p = resolvePath(path);
  for (const root of AUTOMOUNTS) if (p === root || p.startsWith(`${root}/`)) return true;
  return false;
}

export function sameAddress(text: string, uri: string): boolean {
  const bare = (s: string) => s.replace(/\/+$/, "");
  return !!text && bare(text) === bare(uri);
}

function exists(path: string): boolean {
  if (underAutomount(path)) return false;
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function playBell(win: Window): void {
  try {
    const Ctx = (win as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
    osc.onended = () => void ctx.close();
  } catch {
    /* empty */
  }
}

function cellsOf(line: IBufferLine): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) columns.push(x);
    text += chars;
  }
  return { text, columns };
}
