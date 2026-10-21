// What a plugin gives the terminal to host it (PORTING.md). Agent Manager is
// one host, and any plugin can be another: it makes one
// VaultTerminal with this after loading its data, calls load() and unload()
// from its own onload and onunload, and keeps the settings. One
// VaultTerminal per plugin load.

import type { Plugin, TFile } from "obsidian";
import type { TerminalSettings } from "./settings";
import type { CloseReason } from "./close";
import type { ExitInfo } from "./session";
import type { ProgramState } from "./status";
import type { TerminalView } from "./view";

export interface VaultTerminalHost {
  /** The plugin hosting the terminal: its app, and what it registers (the view, events, timers) goes with it. */
  plugin: Plugin;
  /** The name the user knows, in notices and messages ("Agent Manager"). */
  name: string;
  /** The view type terminals register under. Unique to the host: two plugins can't share one. */
  viewType: string;
  /** Where the user finds the terminal's settings, for messages that send them there ("Settings → Agent Manager → Terminal"). */
  settingsPath: string;
  /**
   * The terminal's settings: the same object every call, which the
   * settings controls change in place before calling save. Loaded before
   * the VaultTerminal is made (DEFAULT_TERMINAL_SETTINGS for any missing):
   * load() reads them, and the login shell's probe can save soon after.
   */
  settings(): TerminalSettings;
  /**
   * Saves the settings and the terminal's own small state, all of the
   * host's data with them: called by the settings controls and, on its
   * own, when the login shell's PATH changes. VaultTerminal.state gives
   * the state at any time, for a host that saves its data its own way.
   */
  save(state: VaultTerminalState): Promise<void>;
  /** The state saved last time, read when the VaultTerminal is made. */
  state?: VaultTerminalState;
  /**
   * Web addresses the user opens from a terminal. Without it they go to
   * Obsidian, as a link in a note does (window.open), which opens them in
   * its Web viewer when that's on, or the browser.
   */
  openUrl?(url: string): void;
  /** A note the user opens from a terminal (a path or a name in its text). Without it, a tab already showing the note, or a new tab. */
  openNote?(file: TFile, line?: number): void;
  /**
   * A controller for a new terminal view, or nothing for a plain one. Called
   * as the view is made, before its state is set: the controller then owns
   * how its program starts and what its tab says (TerminalController).
   */
  controller?(view: TerminalView): TerminalController | null;
  /**
   * A window's close was confirmed (a busy terminal asked first). Return
   * true when the host carried out what was asked instead, as a reload; the
   * terminal then leaves the window alone. Otherwise the window is closed.
   */
  windowConfirmed?(win: Window): boolean;
  /** A window's close was held and the user kept it open. */
  windowKept?(win: Window): void;
}

/** What the host's launch adds to an agent's command, decided when each start begins. */
export interface HostLaunch {
  /** Arguments after the agent's command (the setting's, or its default): a session id, a resume. Never dropped by the retry. */
  args?: string[];
  /** The folder it starts in; empty for the vault's. */
  folder?: string;
  /** Without the terminal's additions, for a start that mustn't get them (a one-shot attach). */
  plain?: boolean;
}

/**
 * A host's hold on one terminal view (Agent Manager's session controller).
 * Every member is optional; a view with none behaves as a plain terminal.
 */
export interface TerminalController {
  /** The view waits to start its program until releaseStart(), so the host's own work (a restore) finishes first. */
  readonly gated?: boolean;
  /** The view starts even while hidden, at a default size, and fits when it's first shown. */
  readonly startHidden?: boolean;
  /** Called at the start of each start of an agent: what to add, or an error to show instead of starting. */
  launch?(kind: string, plain: boolean): Promise<HostLaunch | { error: string }> | HostLaunch | { error: string };
  /** The view's elements are made: a slot above the terminal (the pane shrinks to fit it) and the area holding the pane, for an overlay outside the pane's handlers. */
  mount?(slots: { top: HTMLElement; stage: HTMLElement }): void;
  /** The program printed this (decoded, in order). */
  output?(text: string): void;
  /** The user typed or pasted this (every path that reaches the program: keys, paste, drops, the menu). The host's own writes (view.write) aren't here. */
  input?(data: string): void;
  /** The program's state changed (status.ts). */
  stateChange?(state: ProgramState | null): void;
  /** The program started; its pid. */
  started?(pid: number): void;
  /** The program ended. True when the host takes it from here (it restarts the view itself): the terminal then says and does nothing more. */
  exit?(info: ExitInfo): boolean;
  /** A start failed before the program ran (a missing program, no Python). */
  launchFailed?(message: string): void;
  /** Enter after the program ended or a start failed. The host restarts the view (restart()), or refuses. Without it, the view starts again. */
  restart?(): void;
  /** The line shown when the program ends, after "<name> exited with code 0." */
  exitHint?(): string;
  /** The tab's name; null or empty for the terminal's own. */
  name?(): string | null;
  /** The tab's icon when no state icon shows; null for the terminal's own. */
  icon?(): string | null;
  /** Why closing asks first: the terminal's own reason (null when it wouldn't ask) given, the host's returned. Used by the tab's and the window's guard alike. */
  closeReason?(own: CloseReason | null): CloseReason | null;
  /** What the host saves in the view's state, and gets back on restore. */
  getState?(): Record<string, unknown>;
  setState?(state: Record<string, unknown>): void;
  /** The view is closing (its tab closed, or the plugin unloading). */
  closed?(): void;
}

/** What the terminal remembers between loads, beside the settings: the login shell's PATH from the last probe. */
export interface VaultTerminalState {
  loginPath?: string;
}
