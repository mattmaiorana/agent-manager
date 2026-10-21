// One terminal in an Obsidian view. The program starts only once the pane has
// a real size, so its first output is drawn at the right size, and a tab
// restored in the background starts the first time it's shown.

import { ItemView, Menu, Notice, Scope, getIconIds, setIcon, type Modifier, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { Terminal, type ILink, type IBuffer, type IBufferLine, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { statSync } from "fs";
import { execFileSync } from "child_process";
import { homedir, hostname } from "os";
import { isAbsolute, join, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { confirmClose, type VaultTerminal } from "./core";
import type { CloseReason } from "./close";
import type { TerminalController } from "./host";
import { afterExitKey, ctrlCCopies } from "./keys";
import { HelperSession, validSize, type ExitInfo, type Foreground, type StartError } from "./session";
import { findPaths, findUrls } from "./links";
import { clipboardHasOnlyImage, clipboardText, copyText } from "./clipboard";
import { StatusTracker, type Attention, type ProgramState } from "./status";
import { agentById, agentFor, agentForProgram, type AgentProfile } from "./agents";
import { readLook } from "./theme";
import { ReportQueue, WheelCounter, scrollSpeed } from "./wheel";
import { cellSize, resyncViewport, scrollBuffer, sendWheelReport } from "./xterm-internals";
import { PictureLayer } from "./pictures";
import { GraphicsFilter, PICTURE_LINK, findPattern, withoutPlaceholders } from "./kitty";


/** The bundled xterm.js's version, from its package.json at build time (esbuild.config.mjs). */
declare const XTERM_VERSION: string;

interface TopAnchor {
  marker: IMarker;
  /** How far into its line the top row started, in characters. */
  chars: number;
  /** The line's whole text, its wrapped rows joined (wholeLine), to confirm the marker still points at it. */
  text: string;
  /** How many whole lines come after it to the buffer's end: unchanged by reflow. */
  fromEnd: number;
}
/** A shell, or an agent CLI by its id in agents.ts ("claude", "codex", ...). */
export type TerminalKind = string;

/** How a terminal is started, besides what it runs (main.ts, LaunchOptions). */
interface StartOptions {
  plain?: boolean;
  noIntegration?: boolean;
}

// Shells by their process name, with a version or not (zsh, zsh-5.9): a shell's own pid running one is still the shell.
const SHELLS = /^(zsh|bash|fish|sh|dash|ksh|mksh|tcsh|csh|nu|elvish|xonsh)(-[\d.]+)?$/;
// xterm's own word separators, then claude's box lines and corners, curly quotes and bars.
const WORD_SEPARATORS = " ()[]{}',\"`─│┌┐└┘├┤┬┴┼╭╮╯╰‘’“”|";
// The least time between two fits to a new size while a program runs.
const RESIZE_SPACING_MS = 125;
// A start still going after this shows a line naming its step.
const SLOW_START_MS = 5000;
// An agent that exits nonzero within this of starting is tried once without the terminal's additions.
const RETRY_WITHIN_MS = 5000;

// Output backpressure: pause the helper while xterm has this much unparsed.
const OUTPUT_HIGH = 512 * 1024;
const OUTPUT_LOW = 128 * 1024;
// Frames to wait for xterm to measure its font after opening.
const MEASURE_RETRIES = 30;
// When no animation frame comes (a covered window), lay out after this anyway.
const FRAME_FALLBACK_MS = 300;

// Keys the terminal claims from Obsidian's hotkeys while it has focus.
// Obsidian's keymap sees every key before xterm does, so a hotkey bound to one
// of these (Ctrl+Tab switches tabs, for one) would otherwise never reach the
// program, and one bound to Cmd+C or Cmd+V would take copy and paste. Printable keys are never claimed: Option characters, dead keys and
// input methods must reach xterm untouched. Cmd keys stay Obsidian's, except
// the few a terminal uses.
const CTRL_COMBOS: Modifier[][] = [["Ctrl"], ["Ctrl", "Shift"], ["Ctrl", "Alt"], ["Ctrl", "Shift", "Alt"]];
const ANY_MODIFIERS = ["Escape", "Tab", "Enter", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const FUNCTION_KEYS = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);
const CMD_KEYS = ["A", "C", "V", "K", "F", "G", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Backspace", "Delete", "Z"];
// Prompt marks kept for Cmd+Up and Cmd+Down; older ones are dropped.
const MAX_PROMPT_MARKS = 1000;
// After a scrollback reset while scrolled up, how long to look for the same text again.
const RESET_FOLLOW_MS = 1000;
// How many rows at the top are matched to find the place again.
const RESET_ROWS = 5;
// Keys that alone are no action of the user's (cancelReset).
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);
// OSC 52 payloads past this are ignored rather than decoded.
const CLIPBOARD_WRITE_LIMIT = 8 * 1024 * 1024;

// Each state's tab icon, first choice first: icon names vary between the
// Lucide versions Obsidian has shipped.
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

// The view type of the view being constructed (makeTerminalView): ItemView's
// constructor asks for it before the view knows its core.
let constructingType = "";

/** A terminal view for a host's view type. The only way to make one: TerminalView's constructor needs its type set first. */
export function makeTerminalView(leaf: WorkspaceLeaf, core: VaultTerminal): TerminalView {
  constructingType = core.viewType;
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
  /**
   * The program asked whether the terminal speaks the kitty keyboard
   * protocol, so it reads keys in that encoding (claude does). Cmd+C and
   * Cmd+V are passed to such a program in it; others never see them.
   */
  private readsKittyKeys = false;
  /** The agent the running program is, by its file name; null for a shell or any other program. */
  private runningAgent: AgentProfile | null = null;
  private winFocus: { win: Window; fn: () => void } | null = null;
  /** What the program is doing, as far as it has said. Null before the first start. */
  private status: StatusTracker | null = null;
  /** A bell rang while the user wasn't looking; cleared when they look. */
  private bellMarked = false;
  /** The folder the program started in, which relative paths in its output are from. */
  private startDir = homedir();
  /** The shell's current folder, once it reports one (OSC 7); then relative paths are from here. */
  private currentDir: string | null = null;
  /** Where each prompt started (OSC 133;A), for Cmd+Up and Cmd+Down. */
  private promptMarks: IMarker[] = [];
  private search = new SearchAddon();
  private searchBar: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchCount: HTMLElement | null = null;
  /** The self-test turns this off to compare with xterm's own wheel handling. */
  ownWheel = true;
  /** What a start found the pane hidden for, to start when it's shown. */
  private pending: { kind: TerminalKind; folder: string; opts: StartOptions } | null = null;
  /** The running program's launch: what was added to it, and when it started. */
  private launch: { kind: TerminalKind; folder: string; added: string[]; integration: boolean; plain: boolean; at: number } | null = null;
  /** A start in progress, and the line it shows when it's slow. */
  private slow: { timer: number; step: string; shown: boolean } | null = null;
  /** What's running is the tab's own program (an agent), not a shell started after it or with S. */
  private ranProgram = false;
  /** Wheel travel not yet turned into lines (wheel.ts). */
  private wheel = new WheelCounter();
  /** Scroll reports waiting to go to a full-screen program, a frame apart (wheel.ts), where they go, and the frame that sends the next. */
  private reports = new ReportQueue();
  private reportAt: { col: number; row: number; mods: { shift: boolean; alt: boolean; ctrl: boolean }; px: { x: number; y: number } } | null = null;
  private reportFrame = 0;
  private reportWin: Window | null = null;
  /** The rows that were at the top when a program erased the scrollback, to find again in its reprint. */
  private reset: { rows: string[]; from: number; until: number; timer: number; lastLook: number; trailing: number } | null = null;
  /** The line at the top of the view, kept across a move to another window until the next layout. */
  private anchor: TopAnchor | null = null;
  /** When the terminal was last fit to a new size, and the fit waiting to follow it. */
  private lastFitAt = 0;
  private fitTimer = 0;
  private fitTimerWin: Window | null = null;
  /** Pictures: null while "Show pictures" is off, and then none of their code runs. */
  private picturesLayer: PictureLayer | null = null;
  /**
   * Turned off mid-command: the pictures are gone at once, and only the
   * filter stays, swallowing the rest of that command so it isn't printed
   * as text, then goes too.
   */
  private picturesDrain: GraphicsFilter | null = null;
  /** The terminal's foreground program, as the helper last reported it. */
  private foreground: Foreground | null = null;
  /** An agent recognized in a shell tab's foreground, and the shell's own status, kept for when it ends. */
  private recognized: AgentProfile | null = null;
  private shellStatus: StatusTracker | null = null;
  /** The host's hold on this view (host.ts), or null for a plain terminal. */
  readonly controller: TerminalController | null;
  /** Waiting for the controller's releaseStart() before the program starts. */
  private holdStart = false;
  /** Above the terminal, for the host (the pane shrinks to fit it), and the area holding the pane. */
  private top!: HTMLElement;
  private stage!: HTMLElement;
  /** The running program's output, decoded for the controller. */
  private decoder: TextDecoder | null = null;

  constructor(leaf: WorkspaceLeaf, private core: VaultTerminal) {
    super(leaf);
    this.controller = core.host.controller?.(this) ?? null;
    this.holdStart = !!this.controller?.gated;
    this.navigation = false;
    // Pushed by Obsidian while this view has focus. A handler that returns
    // anything but false leaves the key unprevented, so xterm still gets it;
    // keys not listed here go on to Obsidian's own hotkeys.
    this.scope = new Scope(this.app.scope);
    const claim = () => true;
    // Ctrl+Tab and Ctrl+Shift+Tab are Obsidian's (switching tabs): no
    // program in a terminal uses them. Registered before the claim on every
    // Ctrl key, and run as the hotkey Obsidian has for them.
    this.scope.register(["Ctrl"], "Tab", (e) => this.obsidianHotkey(e));
    this.scope.register(["Ctrl", "Shift"], "Tab", (e) => this.obsidianHotkey(e));
    for (const mods of CTRL_COMBOS) this.scope.register(mods, null, claim);
    for (const key of [...ANY_MODIFIERS, ...FUNCTION_KEYS]) {
      // Cmd+Shift and Cmd+Alt with these stay Obsidian's (Cmd+Alt+Left goes back).
      for (const mods of [[], ["Shift"], ["Alt"], ["Shift", "Alt"]] as Modifier[][]) this.scope.register(mods, key, claim);
    }
    for (const key of CMD_KEYS) this.scope.register(["Meta"], key, claim);
    // Find the previous match.
    this.scope.register(["Meta", "Shift"], "G", claim);
  }

  override getViewType(): string {
    // Obsidian's ItemView asks this in its own constructor, before the core is set.
    return this.core?.viewType ?? constructingType;
  }

  override getDisplayText(): string {
    // The host's name for it (a session's title) stands alone.
    const own = this.controller?.name?.();
    if (own) return own;
    const name = this.status?.title || this.foregroundName() || agentById(this.kind)?.name || "Terminal";
    // A progress percent and a session status text, as programs report them.
    const percent = this.status?.percent;
    const text = this.status?.statusText;
    return `${percent !== null && percent !== undefined ? `${percent}% ` : ""}${name}${text ? ` · ${text}` : ""}`;
  }

  /**
   * A parser callback that can't throw into xterm: an exception inside one
   * leaves the chunk being parsed in xterm's write queue with nothing
   * scheduled, so the terminal never draws again.
   * It's logged, and parsing goes on as if the handler had answered fallback.
   */
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
    // The status icons are a setting: off, the tab keeps its own icon.
    if (this.core?.settings.statusIcons === false) return plain;
    const state = this.bellMarked ? "bell" : this.status?.shown;
    if (!state) return plain;
    return (Object.hasOwn(STATE_ICONS, state) ? STATE_ICONS[state] : []).find(has) ?? plain;
  }

  /** The program's state, for the self-test and the tab. */
  get programState(): ProgramState | null {
    return this.status?.shown ?? null;
  }

  get bellShown(): boolean {
    return this.bellMarked;
  }

  override getState(): Record<string, unknown> {
    const state: Record<string, unknown> = { ...super.getState(), kind: this.kind };
    if (this.cwd) state.cwd = this.cwd;
    // The host's own, under a key of its own.
    const hosted = this.controller?.getState?.();
    if (hosted) state.host = hosted;
    return state;
  }

  /** A folder this terminal was asked to start in, instead of the vault's. */
  private cwd = "";

  /** The folder the shell is in, as far as it has said; otherwise where it started. */
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
    // The tab header was drawn before the kind was known.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.schedule();
  }

  protected override async onOpen(): Promise<void> {
    this.core.liveViews.add(this);
    this.contentEl.empty();
    this.contentEl.addClass("vault-terminal-content");
    // A slot for the host above the terminal, and the terminal's own area
    // below it, which the pane fills; the host's overlay goes in the area,
    // beside the pane and outside its handlers.
    this.top = this.contentEl.createDiv({ cls: "vault-terminal-top" });
    this.stage = this.contentEl.createDiv({ cls: "vault-terminal-stage" });
    this.pane = this.stage.createDiv({ cls: "vault-terminal-view" });

    const term = new Terminal({
      allowProposedApi: true, // unicode11 sets term.unicode.activeVersion
      fontSize: this.core.settings.fontSize,
      letterSpacing: this.core.settings.letterSpacing,
      lineHeight: this.core.settings.lineHeight,
      scrollback: this.core.settings.scrollback,
      macOptionIsMeta: this.core.settings.optionKey === "meta",
      macOptionClickForcesSelection: true,
      cursorBlink: false,
      drawBoldTextInBrightColors: false,
      // Text too close to its background is shifted until readable, as VS
      // Code does by default: bright white was white on
      // white in light mode. Only text changes, never a
      // background a program draws.
      minimumContrastRatio: 4.5,
      // The size reports claude asks for once it knows the terminal: CSI 14 t (text area in CSS pixels, as the
      // window size's pixel fields), 16 t (the cell, each side rounded),
      // 18 t (rows and columns). xterm answers them itself; nothing else in
      // windowOptions is turned on.
      windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
      // The cursor's line is reflowed like any other when the terminal
      // narrows. Off (xterm's default), its text past the new width is cut
      // and lost, even widened again: a line a program printed without a
      // newline lost all but its first 40 characters at 40 columns (95,
      // xterm.js #6130).
      reflowCursorLine: true,
      // Double-click selects a word, stopping at these as well as xterm's
      // own: claude's box lines, curly quotes and a bar.
      // The vertical box line too, which claude draws its boxes' sides with.
      wordSeparator: WORD_SEPARATORS,
      // Links a program marks itself (OSC 8): Cmd+click (or a plain click, by
      // the setting) opens them, as with any other link. Without a handler xterm asks with a confirm() box.
      linkHandler: {
        // With plain clicks on, a link whose text isn't its address still
        // takes Cmd+click: a program can put any address behind any text,
        // and a click to focus the pane mustn't open one unseen.
        activate: (event, uri, range) => {
          const shown = this.textIn(range).trim();
          if (event.metaKey || (this.core.opensLink(event) && sameAddress(shown, uri))) this.openUri(uri);
        },
        // Where it goes, since a program's link text can differ from its address.
        hover: (event, uri, range) => {
          if (uri !== PICTURE_LINK) this.showLinkTip(event, uri, sameAddress(this.textIn(range).trim(), uri));
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
    // CSI > q, XTVERSION: the terminal's name and version, answered as VS
    // Code answers it, with xterm.js's own name and the version bundled,
    // never another terminal's. xterm 6.0.0 doesn't answer it.
    term.parser.registerCsiHandler({ prefix: ">", final: "q" }, this.guarded(false, (params: (number | number[])[]) => {
      if (params.length > 1 || (params[0] !== undefined && params[0] !== 0)) return false;
      this.session?.write(`\x1bP>|xterm.js(${XTERM_VERSION})\x1b\\`);
      return true;
    }));
    // CSI ? u: the kitty keyboard query. Noted, then left unanswered, as xterm 6.0.0 does.
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, this.guarded(false, () => {
      this.readsKittyKeys = true;
      return false;
    }));
    // What the program says about itself (status.ts). Each OSC here is one
    // xterm 6.0.0 would otherwise drop.
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
    // Shell integration: the current folder (OSC 7, file://host/path) and
    // where each prompt starts (OSC 133;A).
    term.parser.registerOscHandler(7, this.guarded(true, (data: string) => {
      const m = data.match(/^file:\/\/([^/]*)(\/.*)$/);
      // Only this Mac's folders: a remote shell's (over ssh) mean nothing here.
      if (m && isThisMac(m[1])) {
        let path = m[2];
        try {
          path = decodeURIComponent(path);
        } catch {
          // sent unencoded; use as is
        }
        this.currentDir = path;
      }
      return true;
    }));
    // the terminal's own: the zsh integration reporting a failure of its own.
    term.parser.registerOscHandler(7766, this.guarded(true, (data: string) => {
      if (data === "integration-failed") this.integrationFailed();
      return true;
    }));
    term.parser.registerOscHandler(133, this.guarded(true, (data: string) => {
      if (data === "A" || data.startsWith("A;")) {
        // Back at the shell's prompt: whatever ran in it has ended.
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
    // OSC 52, a program setting or reading the clipboard: setting is
    // allowed; reading is refused, so nothing on the clipboard ever goes
    // back to a program without the user pasting it.
    term.parser.registerOscHandler(52, this.guarded(true, (data: string) => {
      if (!this.core.settings.programClipboard) return true;
      const semi = data.indexOf(";");
      const payload = semi < 0 ? "" : data.slice(semi + 1);
      if (!payload || payload === "?" || payload.length > CLIPBOARD_WRITE_LIMIT) return true;
      // Base64 only: Node's decoder never fails, so anything else would be copied as garbage.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return true;
      copyText(Buffer.from(payload, "base64").toString("utf8"));
      return true;
    }));
    // Which Option key is down, before xterm sees the key it modifies.
    this.registerDomEvent(this.pane, "keydown", (e) => this.trackOption(e), { capture: true });
    this.registerDomEvent(this.pane, "keyup", (e) => this.trackOption(e), { capture: true });
    // A key released while focus was elsewhere never sends its keyup.
    this.registerDomEvent(this.pane, "focusout", () => {
      this.rightOption = this.leftOption = false;
      this.applyOptionKey();
    });
    // Before xterm's own listeners, which send a full-screen program one
    // report per event whatever its distance.
    this.registerDomEvent(this.pane, "wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    // A paste with no text (an image alone on the clipboard): xterm would
    // send the program an empty bracketed paste. Stopped
    // before it; an agent gets Ctrl+V from the Cmd+V keydown instead.
    this.registerDomEvent(this.pane, "paste", (e) => {
      if (!e.clipboardData?.getData("text/plain")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { capture: true });
    // The right button is the terminal's (its menu), not a program's, even
    // when the program has the mouse: otherwise both would act on it.
    // Shift+right-click goes to the program, for those that use it.
    // The release goes where its press went, whatever Shift does in between,
    // so a program never sees a press without its release.
    let rightHeld = false;
    this.registerDomEvent(this.pane, "mousedown", (e) => {
      if (e.button !== 2) return;
      rightHeld = !e.shiftKey && term.modes.mouseTrackingMode !== "none";
      if (rightHeld) e.stopPropagation();
    }, { capture: true });
    this.registerDomEvent(this.pane, "mouseup", (e) => {
      if (e.button !== 2) return;
      if (rightHeld) e.stopPropagation();
      rightHeld = false;
    }, { capture: true });
    // With the mouse the program's, its selection is its own: xterm's handler
    // would select the word under the pointer, and Copy would take that.
    this.registerDomEvent(this.pane, "contextmenu", (e) => {
      if (term.modes.mouseTrackingMode === "none") return;
      e.stopPropagation();
      e.preventDefault();
      if (!e.shiftKey) this.showMenu(e);
    }, { capture: true });
    // Files dropped from Finder or Obsidian's file list: their paths, typed
    // as a paste.
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
    // After xterm's own handler, which selects the word under the pointer.
    this.registerDomEvent(this.pane, "contextmenu", (e) => {
      if (term.modes.mouseTrackingMode === "none") this.showMenu(e);
    });
    // CSI 3 J, erase scrollback: claude's classic renderer sends it (with a
    // clear and a reprint) from time to time, and xterm then parks a
    // scrolled-up view at the first line. Noted before xterm acts on it.
    term.parser.registerCsiHandler({ final: "J" }, this.guarded(false, (params: (number | number[])[]) => {
      if (params[0] === 3) this.noteReset();
      return false;
    }));
    term.onWriteParsed(this.guarded(undefined, () => this.followReset(false)));
    term.onTitleChange(this.guarded(undefined, (title: string) => this.status?.setTitle(title)));
    term.onBell(this.guarded(undefined, () => this.onBell()));
    // The link under the pointer moves with the text: xterm doesn't always say it was left.
    term.onScroll(() => this.hideLinkTip());
    // Focus anywhere in the terminal, or its window coming forward, is looking.
    this.registerDomEvent(this.pane, "focusin", () => this.lookedAt());
    // Back at a full-screen program's end, or a shell's prompt, whatever
    // asked the kitty query has gone; a shell never gets claude's keys.
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
    this.fitTimer = 0;
    this.unhookMigrate?.();
    this.unhookMigrate = null;
    this.stopSession();
    this.picturesLayer?.dispose();
    this.picturesLayer = null;
    this.picturesDrain = null;
    // The retry's notice is about this terminal: it goes with it.
    this.retryNotice?.hide();
    this.retryNotice = null;
    this.term?.dispose();
    this.term = null;
    this.status = null;
    // Once this view is gone from the workspace, it no longer counts.
    window.setTimeout(() => this.core.updateBadge(), 0);
  }

  /** For the dev self-test. */
  get terminal(): Terminal | null {
    return this.term;
  }

  /** For the dev self-test. */
  get current(): HelperSession | null {
    return this.session;
  }

  /** For the dev self-test: the pictures layer, null while pictures are off. */
  get pictures(): PictureLayer | null {
    return this.picturesLayer;
  }

  /**
   * Follows "Show pictures". On: output goes through the pictures
   * layer. Off: the layer and every picture in it go, and output reaches
   * xterm untouched, whose parser drops graphics commands without a trace
   * or a reply. The pictures go at once; a command half-received when it's
   * turned off is swallowed to its end, so its rest isn't printed as text.
   */
  applyPictures(): void {
    const term = this.term;
    if (!term) return;
    const on = this.core.settings.showPictures;
    if (on && !this.picturesLayer) {
      // Back on mid-command: the new layer takes the filter that was
      // swallowing it, so the rest is read as the command it is, not printed.
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
      // the terminal's link around a placeholder run, closed, so later text isn't in it.
      const close = filter.closeLink();
      if (close) term.write(close);
      filter.draining = true;
      this.picturesDrain = filter.busy ? filter : null;
    }
  }

  override onResize(): void {
    this.schedule();
  }

  /** Theme or font changed. */
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
    if (this.term.options.scrollback !== s.scrollback) {
      this.term.options.scrollback = s.scrollback;
      // Fewer lines may have taken the last cells of a picture deleted while they showed it.
      this.picturesLayer?.bufferChanged();
    }
    this.applyOptionKey();
    // The status icons setting may have changed.
    this.updateHeader();
    this.schedule();
  }

  /** Ends the program and everything it started; used on plugin unload. */
  stopSession(withFallback = true): void {
    const s = this.session;
    this.session = null;
    if (!s) return;
    this.core.sessions.delete(s);
    s.close(withFallback);
    if (withFallback) {
      // The fallback timer belongs to the plugin, so unload can drop it.
      this.core.closing.add(s);
      // Gone when its process has exited, whether or not its streams have
      // closed: held any longer, it holds this view and its terminal.
      s.child.once("exit", () => this.core.closing.delete(s));
      s.child.once("close", () => this.core.closing.delete(s));
    }
  }

  // --- sizing ---

  private observe(): void {
    this.observer?.disconnect();
    const win = this.pane.win as Window & typeof window;
    // Coming back to Obsidian with this terminal showing is looking at it.
    if (this.winFocus) this.winFocus.win.removeEventListener("focus", this.winFocus.fn);
    const fn = () => this.lookedAt();
    win.addEventListener("focus", fn);
    this.winFocus = { win, fn };
    // The pane's own window's observer: a popout has its own.
    this.observer = new win.ResizeObserver(() => this.layout());
    this.observer.observe(this.pane);
  }

  private onMigrated(): void {
    this.cancelFrame();
    this.observe();
    this.anchor ??= this.topAnchor();
    if (this.term && this.opened) {
      // xterm's documented step when its element changes browser window.
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
    // A hidden or covered window gets no animation frames (or resize
    // callbacks) until it's seen again, but its timers still run, slowly: so
    // a terminal opened just before switching apps starts anyway.
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

  /**
   * Fit the terminal to the pane and tell the program, but only when the pane
   * is really showing: a hidden pane measures as zero or as the fit addon's
   * 2-by-1 floor, and neither may reach the program.
   */
  private layout(): void {
    const term = this.term;
    if (!term || !this.stateKnown) return;
    if (!this.showing()) {
      // A host's terminal that starts while hidden (its sessions all load at
      // once): at the terminal's default size, fitted when it's first shown.
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
      // Not measured yet (the font may still be loading); try again next frame.
      if (this.retries++ < MEASURE_RETRIES) this.schedule();
      return;
    }
    this.retries = 0;
    if (this.bellMarked) this.lookedAt();
    // A burst of size changes (a sidebar edge being dragged) is applied at
    // most every RESIZE_SPACING_MS, the last always: each fit reflows the
    // whole scrollback, and the program redraws for each size it's told.
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

  /**
   * Where the view is when scrolled up, so a resize or a move keeps it:
   * a marker on the first row of the line at the top, which xterm keeps on
   * that line as text reflows, and how far into the line the top row was.
   * Null at the bottom, which then simply follows the output.
   */
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

  /**
   * Where the anchor's line is now. Its marker, unless that no longer
   * shows the line's text: when narrowing a full scrollback drops rows off
   * its top, xterm.js 6.0.0 leaves markers where they were (seen in 91), so
   * then the line that many whole lines from the end, if its text matches.
   */
  private anchorLine(anchor: TopAnchor): number {
    const buf = this.term!.buffer.active;
    const line = anchor.marker.line;
    // The whole line, not its start: log lines often share their first 40 characters.
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

  /**
   * The scrollback is about to be erased. If the view is scrolled up, keep
   * the text of its top rows: the erase takes the lines themselves (and any
   * marker on them), so the place can only be found again by content.
   */
  private noteReset(): void {
    const term = this.term;
    const buf = term?.buffer.active;
    if (!term || !buf || buf.type !== "normal") return;
    if (this.reset) {
      // Another erase in the same reprint: keep looking for the first place, a second from now.
      const reset = this.reset;
      reset.until = Date.now() + RESET_FOLLOW_MS;
      window.clearTimeout(reset.timer);
      reset.timer = window.setTimeout(() => this.followReset(true), RESET_FOLLOW_MS + 50);
      return;
    }
    if (buf.viewportY >= buf.baseY) return;
    const rows: string[] = [];
    for (let r = 0; r < Math.min(RESET_ROWS, term.rows); r++) rows.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? "");
    // Blank rows can't be found again (they match anywhere), but the
    // fallback still applies: the bottom, not line 1.
    if (!rows.some((t) => t.trim())) rows.length = 0;
    const timer = window.setTimeout(() => this.followReset(true), RESET_FOLLOW_MS + 50);
    this.reset = { rows, from: buf.viewportY, until: Date.now() + RESET_FOLLOW_MS, timer, lastLook: 0, trailing: 0 };
  }

  /**
   * Recovery steps aside once the user acts (a key, a paste, the wheel):
   * where they've gone stands. Not on the program's input in general,
   * since xterm's answers to its queries arrive the same way mid-reprint.
   */
  private cancelReset(): void {
    if (!this.reset) return;
    window.clearTimeout(this.reset.timer);
    window.clearTimeout(this.reset.trailing);
    this.reset = null;
  }

  /**
   * After a reset: once the same rows are back in the buffer, put them at
   * the top again; if they don't come back within a second, go to the
   * bottom rather than leave the view at the first line.
   */
  private followReset(final: boolean): void {
    const reset = this.reset;
    const term = this.term;
    if (!reset || !term) return;
    const now = Date.now();
    if (!final && now - reset.lastLook < 50) {
      // Looked just now: look again once this burst of output has been parsed.
      reset.trailing ||= window.setTimeout(() => {
        if (this.reset === reset) reset.trailing = 0;
        this.followReset(false);
      }, 60);
      return;
    }
    reset.lastLook = now;
    const buf = term.buffer.active;
    // The copy nearest where the view was: a reprint puts the same text at
    // about the same line, and the same rows can recur elsewhere (a rule, a
    // short reply). Only a place that can be scrolled to the top counts;
    // one still in the last screen means the reprint hasn't got past it,
    // and one at the last screen's very top may be a reprint that paused
    // there, so it waits for more output or the last look.
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

  /**
   * The text area in CSS pixels, columns and rows times the cell xterm
   * measured: what the window size's pixel fields carry.
   * Zeros when the cell isn't measured, as before.
   */
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

  // --- the program ---

  private async start(kind: TerminalKind = this.kind, folder = this.cwd, opts: StartOptions = {}): Promise<void> {
    const term = this.term;
    if (!term) return;
    this.starting = true;
    this.ended = false;
    // Counted from now: a terminal hidden until shown starts when it's shown.
    this.beginSlowStart();
    try {
      // The host's part of an agent's command, decided now: each start (a retry, Enter after an exit) asks again.
      const host = kind !== "shell" && this.controller?.launch ? await this.controller.launch(kind, !!opts.plain) : undefined;
      if (!this.term) return; // closed while asking
      if (host && "error" in host) {
        this.endSlowStart();
        this.pending = null;
        this.showProblem(host.error);
        this.ended = true;
        return;
      }
      const launch = await this.core.prepareLaunch(kind, folder, { ...opts, host, step: (what) => this.slowStep(what) });
      if (!this.term) return; // closed while preparing
      // Hidden while Python was being found (another tab, a collapsed
      // sidebar): start when it's shown again, at the size it has then,
      // and the same program (a shell after an agent, not the agent again).
      // A host's terminal that starts hidden goes on at the default size.
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
      // Unknown until it says something, for an agent that reports its
      // state (claude); any other program shows running.
      this.status = new StatusTracker(
        this.runningAgent?.reportsState ? "unknown" : "running",
        !!this.runningAgent?.reportsState,
        () => {
          this.noteState();
          this.updateHeader();
          this.core.updateBadge();
        },
        (a) => this.onAttention(a),
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
      // The pane may have changed size while Python was being found.
      this.schedule();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Terminal.app's keys that xterm doesn't do itself. Returns false when the
   * key is handled here or belongs to Obsidian, so xterm leaves it alone.
   */
  private onKey(e: KeyboardEvent): boolean {
    const term = this.term;
    if (!term) return false;
    // An input method is composing: its keys are its own.
    // Some input methods mark their keys only as "Process", and a dead key's
    // first press (Option+E on a Mac) comes before composition starts: both
    // were keyCode 229.
    if (e.isComposing || e.key === "Process" || e.key === "Dead") return true;
    const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.type !== "keydown") return !e.metaKey;
    if (!MODIFIER_KEYS.has(e.key)) this.cancelReset();
    const send = (data: string) => {
      e.preventDefault();
      this.onInput(data);
      return false;
    };
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    // Escape with text selected clears the selection, and the program reads
    // nothing: in claude and Codex, Escape would interrupt the turn.
    if (e.key === "Escape" && plain && !e.shiftKey && term.hasSelection()) {
      e.preventDefault();
      term.clearSelection();
      return false;
    }
    // Page Up and Page Down (Fn+Up, Fn+Down) page the scrollback in a normal
    // screen, as in Terminal.app; Shift sends them to the program instead.
    // A full-screen program gets them either way.
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
      // With Caps Lock on, Cmd+K comes as "K".
      switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
        case "a":
          // Selects all the terminal's text, the scrollback with it; the
          // program reads nothing. The find bar's own Cmd+A isn't here.
          e.preventDefault();
          term.selectAll();
          return false;
        case "c":
          // Cmd+C never interrupts; Ctrl+C is the interrupt.
          e.preventDefault();
          this.copy();
          return false;
        case "Delete":
          // Cmd+Fn+Delete: delete to the end of the line, Ctrl+K (65).
          return send("\x0b");
        case "z":
          // Undo the last edit in the prompt, Ctrl+_ (65): claude documents it,
          // zsh binds it; an agent shown to do something else with it gets nothing.
          if (this.runningAgent && !this.runningAgent.undoKey) {
            e.preventDefault();
            return false;
          }
          return send("\x1f");
        case "Backspace":
          // Delete to the start of the line, as in a Mac text field: Ctrl+U,
          // which shells and claude read that way.
          return send("\x15");
        case "v":
          // Text: the browser's own paste event follows, and xterm pastes
          // from it, in brackets when the program asked for that. An image
          // alone has no text to paste; an agent CLI (claude, Codex,
          // Antigravity) gets Ctrl+V, which each attaches it on.
          if (this.agentKeys() && clipboardHasOnlyImage()) this.onInput("\x16");
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
          // The full-screen buffer has no scrollback, and the program owns its
          // screen; claude there is asked to redraw instead (Ctrl+L, 68), so
          // Cmd+K does something without blanking it.
          if (term.buffer.active.type === "normal") {
            term.clear();
            // Pictures deleted while the cleared lines showed them can go now.
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
          // The top or bottom of the scrollback. A full-screen program
          // has none of its own here, so it gets Ctrl+Home or Ctrl+End,
          // which claude, vim and less read as its top and bottom.
          e.preventDefault();
          const buf = term.buffer.active;
          if (buf.type === "normal") scrollBuffer(term, (e.key === "Home" ? 0 : buf.baseY) - buf.viewportY);
          else this.onInput(e.key === "Home" ? "\x1b[1;5H" : "\x1b[1;5F");
          return false;
        }
        case "ArrowUp":
        case "ArrowDown":
          // To the previous or next prompt, when the shell marks them.
          e.preventDefault();
          this.jumpToPrompt(e.key === "ArrowUp" ? -1 : 1);
          return false;
      }
    }
    if (e.metaKey) return false;
    // Ctrl+C copies a selection, unless the setting says it always interrupts (keys.ts).
    if (ctrlCCopies(e, term.hasSelection(), !!this.core.settings.ctrlCInterrupts)) {
      e.preventDefault();
      copyText(withoutPlaceholders(term.getSelection()));
      return false;
    }
    // Obsidian's (the scope above runs its hotkey); xterm would send a Tab.
    if (e.key === "Tab" && e.ctrlKey && !e.altKey) return false;
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === "ArrowLeft") return send("\x1bb");
      if (e.key === "ArrowRight") return send("\x1bf");
      // Option+Fn+Delete: delete the next word, Escape then d.
      if (e.key === "Delete") return send("\x1bd");
    }
    // Shift+Enter is a new line in claude's prompt, as Esc then Return.
    if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey) return send("\x1b\r");
    return true;
  }

  /**
   * The wheel, in lines of travel (wheel.ts): scroll reports to a program
   * that has the mouse, queued and sent a frame apart (ReportQueue), arrow keys to a full-screen program that doesn't
   * (as xterm does, one per line instead of one per event), and the
   * scrollback otherwise. Ctrl is a trackpad pinch, left to xterm.
   */
  private onWheel(e: WheelEvent): void {
    const term = this.term;
    if (!term || !this.opened || e.ctrlKey || !this.ownWheel) return;
    const cell = cellSize(term);
    if (!cell) return; // xterm's internals moved: its own handling stands
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

  /**
   * Sends what the report queue allows now, and asks for a frame to send the
   * rest. False when xterm's internals have moved, so the wheel is xterm's.
   */
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

  /**
   * Cmd+C, and the menu's Copy: the terminal's own selection (a shell's, or
   * an Option-drag); otherwise, when the program has the mouse, any
   * selection is its own, and claude and Codex copy it on Super+C (the
   * kitty encoding of Cmd+C), doing nothing when there's none.
   */
  private copy(): void {
    const term = this.term;
    if (!term) return;
    // A picture's placeholder cells are no text.
    if (term.hasSelection()) copyText(withoutPlaceholders(term.getSelection()));
    else if (this.programCopies()) this.onInput("\x1b[99;9u");
  }

  /** Whether closing asks first: closeReason says why, null when it doesn't. */
  needsCloseConfirm(): boolean {
    return this.closeReason() !== null;
  }

  /**
   * Why closing this terminal asks first, or null. An agent of the tab's
   * own asks while it's working or waiting for the user. A shell asks
   * while it runs anything besides itself, in the foreground or as a
   * background job, checked now rather than from the last report; an
   * agent recognized in it asks as a tab's own agent does, and only for
   * itself.
   */
  closeReason(): CloseReason | null {
    const own = this.terminalCloseReason();
    return this.controller?.closeReason ? this.controller.closeReason(own) : own;
  }

  /** The terminal's own reason, before the host's (closeReason). */
  terminalCloseReason(): CloseReason | null {
    const session = this.session;
    if (!session) return null;
    const state = this.status?.shown;
    const busy = state === "working" || state === "waiting";
    if (this.ranProgram) return this.runningAgent && busy ? { agent: true, name: this.runningAgent.name } : null;
    const others = this.processesNow(session);
    if (others === null) {
      // ps failed, so a background job can't be ruled out, beside an idle
      // agent too: ask, naming what the last report knew.
      const fg = this.foreground;
      const name = fg && fg.pgid !== session.programPid ? (this.recognized?.name ?? (fg.script || fg.name)) : `something (${this.core.name} couldn't check)`;
      return { agent: !!this.recognized, name };
    }
    const agentGroup = this.recognized && this.foreground ? this.foreground.pgid : -1;
    const rest = others.filter((p) => p.pgid !== agentGroup);
    if (rest.length) return { agent: false, name: (rest.find((p) => p.foreground) ?? rest[0]).name };
    if (this.recognized && others.length) return busy ? { agent: true, name: this.recognized.name } : null;
    return null;
  }

  /**
   * The processes on the terminal's tty besides the shell itself, from ps
   * at this moment; null if ps couldn't say. Exited ones (zombies) don't count.
   */
  private processesNow(session: HelperSession): { pid: number; pgid: number; foreground: boolean; name: string }[] | null {
    const tty = session.tty.replace(/^\/dev\//, "");
    if (!tty) return null;
    try {
      const out = execFileSync("/bin/ps", ["-t", tty, "-o", "pid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 2000 });
      const list: { pid: number; pgid: number; foreground: boolean; name: string }[] = [];
      const rows = out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
      // The shell's own process group is its own work (startup files, a
      // prompt's substitutions); job control gives every command and job a
      // group of its own.
      const shellRow = rows.find((m) => Number(m[1]) === session.programPid);
      const shellGroup = shellRow?.[2];
      // A shell that ran exec is now that program (exec sleep 100): it counts.
      // Still the shell: the name it was started as, or any shell's, since a
      // wrapper or a link can start a shell under another name.
      const shellName = (shellRow?.[4].split("/").pop() ?? "").replace(/^-/, "");
      const stillShell = !shellRow || shellName === session.programName || SHELLS.test(shellName);
      for (const m of rows) {
        const pid = Number(m[1]);
        if (m[3].startsWith("Z") || (stillShell && (pid === session.programPid || m[2] === shellGroup))) continue;
        list.push({ pid, pgid: Number(m[2]), foreground: m[3].includes("+"), name: m[4].split("/").pop() || m[4] });
      }
      return list;
    } catch (e) {
      // ps exits 1 when nothing matches: nothing else is running.
      if ((e as { status?: number }).status === 1) return [];
      return null;
    }
  }

  /** The foreground program's name for the tab's title, when it isn't the shell. */
  private foregroundName(): string {
    const fg = this.foreground;
    if (!fg || !this.session || fg.pgid === this.session.programPid) return "";
    return this.recognized?.name ?? (fg.script || fg.name);
  }

  /** For the self-test: the foreground program's name, and whether an agent was recognized in it. */
  get foregroundInfo(): { name: string; agent: string | null; at: number } {
    return { name: this.foregroundName(), agent: this.recognized?.id ?? null, at: this.foregroundAt };
  }

  private foregroundAt = 0;

  /**
   * The foreground program changed. In a shell tab, a known agent gets
   * its profile (keys, Cmd+K, Cmd+Z) and its state signals as if the terminal
   * had started it; when it ends, the shell's identity, title and state
   * come back. A tab's own agent is left as it is.
   */
  private onForeground(session: HelperSession, info: Foreground): void {
    if (this.session !== session) return;
    this.foreground = info;
    this.foregroundAt = Date.now();
    if (!this.ranProgram) {
      const agent = info.pgid === session.programPid ? null : agentForProgram(info.script || info.name);
      if (agent !== this.recognized) {
        if (this.recognized && this.shellStatus) {
          // The agent ended: the shell is back as it was.
          this.status = this.shellStatus;
          this.shellStatus = null;
          this.status.programReturned();
        }
        this.recognized = agent;
        this.runningAgent = agent;
        // The agent may have asked for kitty keys before the helper's report
        // named it: that stays. Another program in its place starts afresh.
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
          );
          this.status.start();
          // What it said before it was recognized, to the shell's tracker, is its own.
          if (this.shellStatus) this.status.adopt(this.shellStatus);
        }
        this.core.updateBadge();
      }
    }
    this.updateHeader();
  }

  /**
   * Closing the tab (its close button, Cmd+W, any command) goes through the
   * leaf's detach, which Obsidian offers no way to veto: so this leaf's
   * detach asks first when the agent is busy. Moving the tab doesn't detach it.
   */
  private guardClose(): void {
    const leaf = this.leaf as WorkspaceLeaf & { detach(): void };
    const detach = leaf.detach.bind(leaf);
    leaf.detach = () => {
      const why = this.core.closingAllowed || this.core.confirmedWindows.has(this.pane.win) ? null : this.closeReason();
      if (!why) return detach();
      // In the terminal's own window: closing a popout detaches its tabs
      // first, so a confirmed close that empties a popout closes it too.
      const win = this.pane.win;
      const container = this.leaf.getContainer() as unknown as { close?: () => void };
      confirmClose(this.app, [why], () => {
        detach();
        if (win === window) return;
        // Once the detach has settled: a popout with nothing left in it closes.
        window.setTimeout(() => {
          let left = 0;
          this.app.workspace.iterateAllLeaves((l) => {
            if (l.view.containerEl.win === win) left++;
          });
          if (left || win.closed) return;
          // Obsidian's own window close (internal), which a script's window.close() doesn't reach.
          if (typeof container.close === "function") container.close();
          else win.close();
        }, 100);
      }, win);
    };
  }

  /** Whether the program is claude: the terminal's own, or recognized by its questions (claudeKeys). */
  private isClaude(): boolean {
    return this.runningAgent?.id === "claude" || this.claudeKeys();
  }

  /**
   * The Option key setting: with "right", the right Option key acts as
   * Meta while it's held and the left one still types characters. Which one
   * is down is known from the modifier's own keydown and keyup (its code is
   * AltLeft or AltRight); xterm then encodes Meta itself.
   */
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

  /** For the self-test. */
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

  /** Whether Cmd+C goes to the program, which has the mouse and copies its own selection. */
  private programCopies(): boolean {
    return !!this.term && this.agentKeys() && this.term.modes.mouseTrackingMode !== "none";
  }

  /** The menu's Paste: what Cmd+V does for the same clipboard, an image alone included. */
  private pasteFromMenu(): void {
    const term = this.term;
    if (!term) return;
    if (clipboardHasOnlyImage()) {
      if (this.agentKeys()) this.onInput("\x16");
      return;
    }
    const text = clipboardText();
    if (!text) return;
    this.cancelReset();
    term.paste(text);
  }

  /** Absolute paths of what's being dragged: files from Finder, or notes and folders from Obsidian's own lists. */
  private droppedPaths(e: DragEvent): string[] {
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      const p = filePath(f);
      if (p) paths.push(p);
    }
    if (paths.length) return paths;
    // A drag inside Obsidian (its file list) carries Obsidian's own record, not files.
    const drag = (this.app as unknown as { dragManager?: { draggable?: { type?: string; file?: { path: string }; files?: { path: string }[] } | null } }).dragManager?.draggable;
    const items = drag?.files ?? (drag?.file ? [drag.file] : []);
    for (const item of items) paths.push(this.core.absolutePath(item.path));
    return paths;
  }

  /** Paths typed at the cursor as one paste, each quoted for a shell as needed, nothing run. */
  typePaths(paths: string[]): void {
    if (!this.term || !paths.length) return;
    this.cancelReset();
    this.term.paste(`${paths.map(shellQuote).join(" ")} `);
  }

  /** Right-click: Copy and Paste. */
  private showMenu(e: MouseEvent): void {
    if (!this.term) return;
    e.preventDefault();
    const items = [
      { title: "Copy", icon: "copy", disabled: !this.term.hasSelection() && !this.programCopies(), run: () => this.copy() },
      { title: "Paste", icon: "clipboard-paste", disabled: false, run: () => this.pasteFromMenu() },
    ];
    const menu = new Menu();
    for (const item of items) menu.addItem((i) => i.setTitle(item.title).setIcon(item.icon).setDisabled(item.disabled).onClick(item.run));
    menu.showAtMouseEvent(e);
    this.lastMenu = { items, hide: () => menu.hide() };
  }

  private linkTip: HTMLElement | null = null;

  /**
   * A small tip by the pointer naming where a link goes, and how to open
   * it. A link whose text isn't its address always takes Cmd+click.
   */
  private showLinkTip(event: MouseEvent, address: string, textIsAddress: boolean): void {
    const el = this.term?.element;
    if (!el) return;
    this.hideLinkTip();
    const tip = el.ownerDocument.createElement("div");
    // xterm-hover: xterm lets mouse events over it pass as if it weren't there.
    tip.className = "vault-terminal-link-tip xterm-hover";
    const how = this.core.settings.linkClick === "click" && textIsAddress ? "Click to open" : "Cmd+click to open";
    tip.createDiv({ cls: "vault-terminal-link-tip-address", text: address });
    tip.createDiv({ cls: "vault-terminal-link-tip-how", text: how });
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(event.clientX - r.left + 12, r.width - 320))}px`;
    el.appendChild(tip);
    // Below the pointer, or above it where below would be cut off at the terminal's bottom.
    const below = event.clientY - r.top + 18;
    const above = event.clientY - r.top - 8 - tip.offsetHeight;
    tip.style.top = `${Math.max(0, below + tip.offsetHeight > r.height && above >= 0 ? above : below)}px`;
    this.linkTip = tip;
  }

  private hideLinkTip(): void {
    this.linkTip?.remove();
    this.linkTip = null;
  }

  /** For the self-test: the link tip's text while it shows. */
  get linkTipText(): string | null {
    return this.linkTip?.isConnected ? this.linkTip.innerText || this.linkTip.textContent : null;
  }

  /** For the self-test: the last right-click menu shown. */
  lastMenu: { items: { title: string; disabled: boolean; run: () => void }[]; hide(): void } | null = null;

  /** For the dev self-test: what the last Ctrl+Tab did. */
  lastHotkey: { id: string | null; removed: boolean; ran: boolean } | null = null;

  /**
   * Ctrl+Tab or Ctrl+Shift+Tab: runs the command Obsidian has on that hotkey
   * (by default, the next or previous tab). The view's scope claims every
   * other Ctrl key for the program, so Obsidian's own matching never sees it.
   */
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
      // Obsidian's hotkey list moved; the defaults below
    }
    const fallback = e.shiftKey ? "workspace:previous-tab" : "workspace:next-tab";
    // The default command's own hotkeys changed (even to none), and nothing
    // has Ctrl+Tab: the user took it off, so it does nothing.
    let removed = false;
    try {
      removed = !id && app.hotkeyManager?.getHotkeys(fallback) !== undefined;
    } catch {
      // as above
    }
    const ran = !removed && app.commands.executeCommandById(id ?? fallback);
    this.lastHotkey = { id, removed, ran };
    return false;
  }

  /**
   * Web addresses on buffer line y (1-based), for Cmd+click. A long address
   * wraps onto the rows below, so the whole wrapped line is read and each
   * address spans the rows it's on.
   */
  private linksOn(y: number): ILink[] | undefined {
    const buf = this.term?.buffer.active;
    if (!buf?.getLine(y - 1)) return undefined;
    let first = y - 1;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    let last = y - 1;
    while (buf.getLine(last + 1)?.isWrapped) last++;
    // Text, and the cell each character starts in; wide characters take two.
    let text = "";
    const cells: { x: number; y: number }[] = [];
    for (let row = first; row <= last; row++) {
      const part = cellsOf(buf.getLine(row)!);
      text += part.text;
      for (const x of part.columns) cells.push({ x: x + 1, y: row + 1 });
    }
    const urls = findUrls(text).map(
      (l): ILink => ({
        text: l.url,
        range: { start: cells[l.start], end: cells[l.end - 1] },
        activate: (event, url) => {
          if (this.core.opensLink(event)) this.openUri(url);
        },
        hover: (event, url) => this.showLinkTip(event, url, true),
        leave: () => this.hideLinkTip(),
      }),
    );
    // File paths that exist, from the folder the program started in,
    // or a note in the vault by its vault path or its name alone. A :line after the path opens a note at that line.
    const paths = findPaths(text, (p) => exists(this.resolve(p)) || !!this.core.vaultNote(p)).map(
      (l): ILink => ({
        text: l.path,
        range: { start: cells[l.start], end: cells[l.end - 1] },
        hover: (event) => {
          const abs = this.resolve(l.path);
          this.showLinkTip(event, exists(abs) ? abs : (this.core.vaultNote(l.path)?.path ?? l.path), true);
        },
        leave: () => this.hideLinkTip(),
        activate: (event) => {
          if (!this.core.opensLink(event)) return;
          const line = Number(text.slice(l.end).match(/^:(\d+)/)?.[1] ?? 0) || undefined;
          const abs = this.resolve(l.path);
          if (exists(abs)) this.core.openPath(abs, line);
          else {
            const note = this.core.vaultNote(l.path);
            if (note) void this.core.openNote(note, line);
          }
        },
      }),
    );
    const links = [...urls, ...paths].filter((l) => l.range.start.y <= y && l.range.end.y >= y);
    return links.length ? links : undefined;
  }

  private resolve(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return isAbsolute(p) ? p : join(this.folder, p);
  }

  /** Scrolls so the previous (-1) or next (1) prompt is at the top. */
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

  /** The terminal's text: everything in its scrollback and on screen, or the full-screen program's screen. */
  text(): string {
    const term = this.term;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      // A row that continues on the next keeps its trailing spaces: they're text, not padding.
      const t = line.translateToString(!buf.getLine(i + 1)?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += t;
      else lines.push(t);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return withoutPlaceholders(lines.join("\n"));
  }

  /** The text in a buffer range, as xterm gives a link's (1-based, end inclusive). */
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

  /** A link's address: web addresses in the Web viewer or the browser, file addresses as paths. */
  private openUri(uri: string): void {
    if (/^https?:\/\//i.test(uri)) this.core.openUrl(uri);
    else if (/^file:\/\//i.test(uri)) {
      try {
        this.core.openPath(fileURLToPath(uri));
      } catch {
        // not a local file address
      }
    }
  }

  // --- search ---

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
      // On the whole bar, so Escape works from its buttons too.
      bar.addEventListener("keydown", (e) => {
        // An input method is composing: Enter and Escape are its own.
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
    // Opening the bar doesn't move the view: Enter or typing finds.
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
    // A query with one of a picture's marks never matches inside a picture.
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

  /** For the self-test: the search bar's input and its count, when open. */
  get searchState(): { open: boolean; count: string } {
    return { open: !!this.searchBar?.isShown(), count: this.searchCount?.getText() ?? "" };
  }

  private onInput(data: string): void {
    if (this.session) {
      if (data.includes("\r")) this.status?.answered();
      else if (data === "\x1b") this.status?.escaped();
      this.session.write(data);
      this.controller?.input?.(data);
    } else if (this.ended && !this.starting) {
      // After the program ends, Enter starts it again; S starts a shell,
      // except in a host's terminal, whose Enter is the host's (keys.ts).
      const what = afterExitKey(data, !!this.controller);
      if (what === "restart") {
        if (this.controller?.restart) this.controller.restart();
        else void this.start(this.kind);
      } else if (what === "shell") void this.start("shell");
    }
  }

  private onOutput(chunk: Uint8Array): void {
    const term = this.term;
    if (!term) return;
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

  /** For the self-test: how the last session ended, with its helper's diagnostics. */
  lastExit: { info: ExitInfo; helper: string; ranFor: number } | null = null;

  private onExit(session: HelperSession, info: ExitInfo): void {
    if (this.session === session) this.lastExit = { info, helper: session.diagnostics.slice(-600), ranFor: this.launch ? Date.now() - this.launch.at : -1 };
    if (this.session !== session) return;
    this.endSlowStart();
    this.core.sessions.delete(session);
    this.session = null;
    this.ended = true;
    this.status?.exit();
    // The host may take it from here (a resume after a failed attach).
    if (this.controller?.exit?.(info)) return;
    // An agent that failed at once with the terminal's additions is started
    // again once without them, before anything else is decided (the
    // shell after an agent waits for this). What it printed stays.
    const l = this.launch;
    if (l && this.ranProgram && l.added.length && !l.plain && typeof info.code === "number" && info.code !== 0 && !info.closed && (info.ran !== undefined ? info.ran * 1000 : Date.now() - l.at) < RETRY_WITHIN_MS) {
      this.retryPlain(l);
      return;
    }
    const how = info.signal ? `was ended by signal ${info.signal}` : `exited with code ${info.code ?? "unknown"}`;
    const agent = agentById(this.kind);
    const name = agent?.name ?? "The program";
    // An agent's tab becomes a shell in the folder it started in, its
    // scrollback kept, unless the setting says to wait.
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

  // --- status, bell, notifications ---

  private updateHeader(): void {
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  /** The user can see this terminal: it's showing, in a window that has focus. */
  private looking(): boolean {
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

  /** For the self-test: each state the tab showed, and each notification dispatched, with when. */
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

  /** The program asked for attention. Notifications are a setting, off by default. */
  private onAttention(a: Attention): void {
    if (!this.core.settings.notifications || this.looking()) return;
    const text = a.body || a.title;
    const name = this.getDisplayText();
    // An Obsidian notice only where it can be seen: Obsidian in front, and
    // this terminal's own window showing. Minimized while another vault's
    // window had focus, it went to the minimized window unseen.
    const inFront = this.core.obsidianInFront() && this.pane.doc.visibilityState === "visible";
    this.attentionLog.push({ how: inFront ? "notice" : "notification", at: Date.now() });
    if (this.attentionLog.length > 200) this.attentionLog.splice(0, 100);
    if (inFront) {
      const notice = new Notice(`${name}: ${text}`, 10000);
      // The whole notice is the click target, not just its text.
      (notice.messageEl.closest(".notice") ?? notice.messageEl).addEventListener("click", () => this.bringForward());
    } else {
      const n = new Notification(a.title || name, { body: a.title && a.title !== name ? `${name}: ${text}` : text, silent: true });
      n.onclick = () => this.bringForward();
    }
  }

  /**
   * Whether the program is claude, as far as the terminal can tell: it asked
   * both the kitty keyboard query and the Program Status Protocol query
   * (claude 2.1.295 or later does both), and it's the terminal's own program
   * or has the full screen. Only then are Cmd+C and an image-only Cmd+V sent
   * on as Super+C and Ctrl+V, which claude was seen to act on.
   */
  private claudeKeys(): boolean {
    const term = this.term;
    if (!term || !this.readsKittyKeys || !this.status?.asksStatus) return false;
    return this.runningAgent?.id === "claude" || term.buffer.active.type === "alternate";
  }

  /**
   * Whether Cmd+C and an image-only Cmd+V go on as Super+C and Ctrl+V: to
   * claude wherever it runs (above), and to the terminal's own program when
   * its agent profile says it was shown to act on both (Codex, Antigravity).
   * Never to a program only because it asked for kitty keys: an editor does
   * too, and Ctrl+V there is visual block mode.
   */
  private agentKeys(): boolean {
    return this.claudeKeys() || !!this.runningAgent?.agentKeys;
  }

  /** For the self-test. */
  get readsAgentKeys(): boolean {
    return this.agentKeys();
  }

  /** Brings Obsidian, this terminal's window, and the terminal itself forward. */
  bringForward(): void {
    this.core.activateApp();
    this.pane.win.focus();
    void this.app.workspace.revealLeaf(this.leaf);
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    this.term?.focus();
  }

  /**
   * A program that ended abruptly can leave its full-screen buffer, a hidden
   * cursor, mouse reporting or bracketed paste on; the next program shouldn't
   * inherit them. The screen's contents and scrollback stay.
   */
  private resetModes(then: string): void {
    const term = this.term;
    if (!term) return;
    // Once the program's last output is parsed: leaving the full-screen
    // buffer also restores the cursor saved on entering it, so it's sent
    // only when that buffer is showing.
    term.write("", () => {
      if (this.term !== term) return;
      const leave = term.buffer.active.type === "alternate" ? "\x1b[?1049l" : "";
      term.write(`${leave}\x1b[!p\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b>\x1b[0m${then}`);
    });
  }

  // --- starting ---

  /** A start began: if it's still going in 5 s, a dim line says which step it's on. */
  private beginSlowStart(): void {
    this.endSlowStart();
    const slow = { timer: 0, step: "starting", shown: false };
    slow.timer = window.setTimeout(() => {
      if (this.slow !== slow || !this.term) return;
      slow.shown = true;
      // On a row of its own: after a first start's text the cursor can be mid-row, where the line would wrap.
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

  /**
   * The slow-start line, cut to fit one row: a line that wrapped in a
   * narrow sidebar would leave its first rows behind when erased.
   */
  private slowLine(step: string): string {
    const text = `[Still starting: ${step}…]`;
    const room = Math.max(4, (this.term?.cols ?? 80) - 1);
    return text.length <= room ? text : `${text.slice(0, room - 2)}…]`;
  }

  /** The start succeeded or failed: its line goes, so it's never left above the prompt. */
  private endSlowStart(): void {
    const slow = this.slow;
    if (!slow) return;
    window.clearTimeout(slow.timer);
    this.slow = null;
    if (slow.shown) this.term?.write("\r\x1b[2K");
  }

  /** For the self-test: the slow-start line's step while it shows, or null. */
  get slowStartShown(): string | null {
    return this.slow?.shown ? this.slow.step : null;
  }

  /**
   * zsh's shell integration reported a failure of its own (OSC 7766): the
   * shell starts again once without it, and a dim line says so.
   */
  private integrationFailed(): void {
    const l = this.launch;
    if (!this.session || !l?.integration || this.ranProgram) return;
    this.stopSession();
    this.ended = false;
    void this.start("shell", l.folder, { noIntegration: true }).then(() => {
      this.term?.write("\x1b[2m[Shell integration failed to start, so this terminal runs without it.]\x1b[0m\r\n");
    });
  }

  /** For the self-test: the last retry's outcome, if any. */
  lastRetry: { why: string; line: boolean; notice: boolean } | null = null;

  /**
   * The agent exited nonzero within 5 s of starting with the terminal's
   * additions: it's started once more without them. the terminal can't
   * tell whose settings failed, so the rule is by outcome. If the second
   * start is still running 5 s later, a dim line names what was dropped; in
   * a full-screen program's screen, a notice instead, since a line there
   * would break its drawing. If it fails too, nothing is added.
   */
  private retryPlain(l: NonNullable<TerminalView["launch"]>): void {
    this.resetModes("");
    this.lastRetry = { why: `exited at once with ${l.added.join(", ")}`, line: false, notice: false };
    // Explained once the second start runs, whenever that is: at once, or
    // when a tab hidden meanwhile is shown (start() defers it then).
    this.retryNote = l.added;
    void this.start(l.kind, l.folder, { plain: true });
  }

  /** The notice a retry in a full screen left, for the self-test to see and dismiss. */
  retryNotice: Notice | null = null;

  /** What the second start dropped, waiting for that start's session. */
  private retryNote: string[] | null = null;

  /** The line, or in a full screen the notice, naming what was dropped, if the second start still runs after 5 s. */
  private explainRetry(second: HelperSession, added: string[]): void {
    window.setTimeout(() => {
      if (this.session !== second || !second.running || !this.term) return;
      const text = `Started without what ${this.core.name} adds (${added.join(", ")}): the first start ended at once.`;
      if (this.term.buffer.active.type === "normal") {
        this.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
        if (this.lastRetry) this.lastRetry.line = true;
      } else {
        // A full screen has no line to spare, so a notice, and one that stays
        // until clicked: the session runs without its tab
        // state, notifications and pictures, and a notice that faded could go unseen.
        this.retryNotice?.hide();
        this.retryNotice = new Notice(`${this.getDisplayText()}: ${text} Its tab state, notifications and pictures are off in this session. Click to dismiss.`, 0);
        if (this.lastRetry) this.lastRetry.notice = true;
      }
    }, RETRY_WITHIN_MS);
  }

  // --- for a host's controller (host.ts) ---

  /** The gate opens: the program starts once the pane has a size (or at once, for a terminal that starts hidden). */
  releaseStart(): void {
    if (!this.holdStart) return;
    this.holdStart = false;
    this.schedule();
  }

  /** Starts the program again after it ended or a start failed; the host's launch decides what runs. Nothing while one runs or starts. */
  restart(): void {
    if (this.session || this.starting) return;
    this.ended = false;
    this.pending = null;
    void this.start(this.kind);
  }

  /** Whether a program is running in the terminal now. */
  get running(): boolean {
    return !!this.session?.running;
  }

  /** The running program's pid (the program's, not the helper's), or 0. */
  get programPid(): number {
    return this.session?.programPid ?? 0;
  }

  /** Writes to the program as typed, without the input event: the host's own writes never count as the user's. */
  write(data: string): boolean {
    if (!this.session) return false;
    this.cancelReset();
    this.session.write(data);
    return true;
  }

  /** Whether the program asked for bracketed paste, so a long write can go in as one paste. */
  get bracketedPaste(): boolean {
    return !!this.term?.modes.bracketedPasteMode;
  }

  /** Pastes as the user would (Cmd+V): bracketed when the program asked for it, and it counts as the user's input. */
  paste(text: string): void {
    if (!this.term || !text) return;
    this.cancelReset();
    this.term.paste(text);
  }

  /** Focuses the terminal. */
  focus(): void {
    this.term?.focus();
  }

  /** How many rows the screen shows. */
  get screenRows(): number {
    return this.term?.rows ?? 0;
  }

  /** The last rows up to the bottom of the screen, as text, one line per row: cheap, for watching what a program shows now. */
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

  /** Text selected in the terminal, or "". */
  get selection(): string {
    return this.term?.hasSelection() ? withoutPlaceholders(this.term.getSelection()) : "";
  }

  /** The tab's name or icon changed (the host's). */
  refreshHeader(): void {
    this.updateHeader();
  }

  /** The title the program last set (OSC 0 or 2), or "". */
  get programTitle(): string {
    return this.status?.title ?? "";
  }

  /** The program's state as the terminal knows it, or null before the first start. */
  get state(): ProgramState | null {
    return this.status?.shown ?? null;
  }

  /** A dim line of the host's in the terminal, on a row of its own (not sent to the program). */
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

/** A dropped file's path on disk, through Electron (File.path is gone in recent Electron). */
function filePath(file: File): string {
  try {
    const electron = (window as unknown as { require(m: string): { webUtils?: { getPathForFile(f: File): string } } }).require("electron");
    const p = electron.webUtils?.getPathForFile(file);
    if (p) return p;
  } catch {
    // no Electron; the older property below
  }
  return (file as File & { path?: string }).path ?? "";
}

/** A line's first row of text, for recognizing it again after a reflow. */
/**
 * A line's whole text from its first row, the rows it wraps onto joined.
 * Each row ends at its last written cell: a wide character that didn't fit
 * at a row's end leaves a cell never written there (empty, where a space
 * the program wrote is " "), which another width doesn't have. Spaces the
 * program wrote stay, so lines that differ only by them don't match.
 */
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

/** A path as one shell word: as is when it's plain, otherwise in single quotes. */
export function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Whether an OSC 7 host is this Mac: empty, localhost, or its own name. */
function isThisMac(host: string): boolean {
  const h = host.toLowerCase();
  const me = hostname().toLowerCase();
  return !h || h === "localhost" || h === me || h === me.replace(/\.local$/, "") || `${h}.local` === me;
}

/**
 * Folders an automounter serves. A lookup under one can start a network
 * mount, with DNS and NFS timeouts, and links are looked up on a plain hover,
 * synchronously: hovering a printed /net/host/... path would freeze Obsidian.
 * Paths there are never looked up, so they aren't links. macOS's defaults,
 * plus what /sbin/mount lists as autofs (core.ts).
 */
const AUTOMOUNTS = new Set(["/net", "/home", "/Network", "/System/Volumes/Data/home", "/System/Volumes/Data/Network"]);

export function noteAutomounts(paths: string[]): void {
  for (const p of paths) if (p.startsWith("/") && p !== "/") AUTOMOUNTS.add(p.replace(/\/+$/, ""));
}

export function underAutomount(path: string): boolean {
  const p = resolvePath(path);
  for (const root of AUTOMOUNTS) if (p === root || p.startsWith(`${root}/`)) return true;
  return false;
}

/** Whether a link's text is its address, give or take a trailing slash. */
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

/** A short, quiet tone for the bell, when the setting is on. */
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
    // no audio; the tab mark still shows
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
