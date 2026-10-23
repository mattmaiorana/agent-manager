// Parts of Obsidian the plugin uses that its published types leave out. Each is optional
// where the code checks for it before use. Types only.

import type { TAbstractFile, TFile, Workspace, WorkspaceLeaf, WorkspaceParent } from "obsidian";

declare module "obsidian" {
  interface App {
    // The command registry: the plugin wraps the reload command (plugin/terminal-host.ts).
    commands?: {
      commands?: Record<string, InternalCommand | undefined>;
    };
    // The core plugins: the file explorer's reveal (notes/view-note.ts).
    internalPlugins?: {
      getEnabledPluginById?(id: string): { revealInFolder?(file: TAbstractFile): void } | null;
    };
  }
  interface DataAdapter {
    // The vault's folder on disk (FileSystemAdapter's, on the desktop).
    basePath?: string;
  }
  interface WorkspaceParent {
    // "tabs" for a tab group.
    type?: string;
    children?: WorkspaceLeaf[];
  }
  interface WorkspaceLeaf {
    pinned?: boolean;
    history?: {
      serialize(): unknown;
      deserialize(state: unknown): void;
    };
    canNavigate?(): boolean;
    // Redraws the tab's header (its name and icon).
    updateHeader?(): void;
  }
  interface View {
    // A file view's file (FileView has it; other views don't).
    file?: TFile | null;
  }
}

// A command in the registry, as the reload command's wrapper sees it.
export interface InternalCommand {
  callback?: ((...args: unknown[]) => unknown) & { _agentManagerWrapped?: boolean };
}

// The workspace members the plugin has always used that Obsidian marks deprecated
// (activeLeaf, getUnpinnedLeaf) or doesn't publish (createLeafInTabGroup), read through
// this type. Replacing the deprecated ones would change what the plugin does, so that's
// left for its own change. A Workspace is one of these as it is: no cast.
export interface WorkspaceInternals {
  activeLeaf: WorkspaceLeaf | null;
  // Both wrapped by the note routing (plugin/workspace.ts, installOpenRouting).
  getUnpinnedLeaf?: (this: Workspace, setActive?: boolean) => WorkspaceLeaf;
  createLeafInTabGroup?: (this: Workspace, parent?: WorkspaceParent) => WorkspaceLeaf;
}
