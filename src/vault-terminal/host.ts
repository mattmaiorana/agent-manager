
import type { Menu, Plugin, TFile } from "obsidian";
import type { TerminalSettings } from "./settings";
import type { CloseReason } from "./close";
import type { ExitInfo } from "./session";
import type { ProgramState } from "./status";
import type { TerminalView } from "./view";
import type { ObsidianLink } from "./links";

export interface VaultTerminalHost {
  plugin: Plugin;
  name: string;
  viewType: string;
  plainViewType?: string;
  settingsPath: string;
  settings(): TerminalSettings;
  save(state: VaultTerminalState): Promise<void>;
  state?: VaultTerminalState;
  openUrl?(url: string): void;
  openObsidianLink?(link: ObsidianLink): boolean;
  openNote?(file: TFile, line?: number): void;
  controller?(view: TerminalView): TerminalController | null;
  windowConfirmed?(win: Window): boolean;
  windowKept?(win: Window): void;
}

export interface HostLaunch {
  args?: string[];
  folder?: string;
  plain?: boolean;
  env?: Record<string, string>;
}

export interface TerminalController {
  readonly gated?: boolean;
  readonly startHidden?: boolean;
  launch?(kind: string, plain: boolean): Promise<HostLaunch | { error: string }> | HostLaunch | { error: string };
  mount?(slots: { top: HTMLElement; stage: HTMLElement }): void;
  output?(text: string): void;
  input?(data: string): void;
  inputCleared?(): void;
  inputEdited?(): void;
  dialogShowing?(): boolean;
  notifiesItself?(): boolean;
  stateChange?(state: ProgramState | null): void;
  bridge?(id: string, atStart: boolean): void;
  started?(pid: number): void;
  exit?(info: ExitInfo): boolean;
  launchFailed?(message: string): void;
  restart?(): void;
  exitHint?(): string;
  name?(): string | null;
  icon?(): string | null;
  closeReason?(own: CloseReason | null): CloseReason | null;
  paneMenu?(menu: Menu, source: string): void;
  getState?(): Record<string, unknown>;
  setState?(state: Record<string, unknown>): void;
  closed?(): void;
}

export interface VaultTerminalState {
  loginPath?: string;
}
