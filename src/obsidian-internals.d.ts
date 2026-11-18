
import type { TAbstractFile, TFile, Workspace, WorkspaceLeaf, WorkspaceParent } from "obsidian";

declare module "obsidian" {
  interface App {
    commands?: {
      commands?: Record<string, InternalCommand | undefined>;
    };
    internalPlugins?: {
      getEnabledPluginById?(id: string): { revealInFolder?(file: TAbstractFile): void; options?: { openExternalURLs?: boolean } } | null;
    };
  }
  interface DataAdapter {
    basePath?: string;
  }
  interface WorkspaceItem {
    containerEl?: HTMLElement;
  }
  interface WorkspaceSplit {
    direction?: string;
  }
  interface WorkspaceParent {
    type?: string;
    children?: WorkspaceLeaf[];
    containerEl?: HTMLElement;
    selectTabIndex?(index: number): void;
    currentTab?: number;
    insertChild?(index: number, child: WorkspaceLeaf): void;
    removeChild?(child: WorkspaceLeaf): void;
    setDimension?(dimension: number | null): void;
  }
  interface Workspace {
    floatingSplit?: { children?: WorkspaceWindow[] };
  }
  interface WorkspaceWindow {
    close?: (this: WorkspaceWindow) => void;
  }
  interface WorkspaceLeaf {
    pinned?: boolean;
    setDimension?(dimension: number | null): void;
    activeTime?: number;
    tabHeaderEl?: HTMLElement;
    history?: {
      serialize(): unknown;
      deserialize(state: unknown): void;
    };
    canNavigate?(): boolean;
    updateHeader?(): void;
  }
  interface View {
    file?: TFile | null;
  }
}

export interface InternalCommand {
  callback?: ((...args: unknown[]) => unknown) & { _agentManagerWrapped?: boolean };
}

export interface WorkspaceInternals {
  getUnpinnedLeaf?: (this: Workspace, setActive?: boolean) => WorkspaceLeaf;
  createLeafInTabGroup?: (this: Workspace, parent?: WorkspaceParent) => WorkspaceLeaf;
}
