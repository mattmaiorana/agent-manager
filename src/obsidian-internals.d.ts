
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
  interface WorkspaceParent {
    type?: string;
    children?: WorkspaceLeaf[];
  }
  interface WorkspaceLeaf {
    pinned?: boolean;
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
