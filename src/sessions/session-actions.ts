// What the browser and a session's strip both do to a session: rename it, show its
// backend, and open a vault file. A part applied to both views, so it never names
// either class.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS } from "../constants/backends.js";
import { INPUT_GUARD_NOTICE_MS } from "./constants.js";
import type { App, TFile } from "obsidian";
import type { CliBackend } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { Session } from "./controller.js";

// What both views give this part: the plugin, and the app.
interface SessionActionHost {
  plugin: AgentManagerPlugin;
  app: App;
}
// The session a rename is for, as both views describe it (a sidebar row's record, or the
// strip's own).
interface RenameTarget {
  sessionId: string | null;
  title: string;
  backend: string;
  displayName: string;
}
class SessionActionMethods {
  // A small pill naming a session's CLI backend, color-coded per backend.
  appendBackendBadge(parentEl: HTMLElement, backendKey: string): HTMLElement {
    // Any name: one CLI_BACKENDS doesn't have reads undefined.
    const backend = (CLI_BACKENDS as Partial<Record<string, CliBackend>>)[backendKey];
    return parentEl.createSpan({
      cls: "agent-manager-backend-badge",
      text: backend ? (backend.badge || backend.binary) : backendKey,
      attr: { "data-backend": backendKey }
    });
  }
  // The rename itself, no re-render (callers render their own surface). A rename is
  // an override in plugin data, keyed by the session id, over the name the transcript
  // was launched with. `session` needs { sessionId, title, backend, displayName }.
  async applyRename(this: SessionActionHost, session: RenameTarget, rawSubject: string | null): Promise<boolean> {
    if (!session.sessionId) return false;
    const finalName = (rawSubject || "").trim();
    if (!finalName || finalName === session.displayName) return false;
    const newTitle = finalName;
    if (!this.plugin.pluginData.sessionNames) this.plugin.pluginData.sessionNames = {};
    this.plugin.pluginData.sessionNames[session.sessionId] = finalName;
    await this.plugin.savePluginData();
    this.plugin.invalidateSessionIndex();
    // If it's open, relabel the live tab now, so the open-session lookups keep matching.
    const leaf = this.plugin.getLeafForSession(session.title, session.backend, session.sessionId);
    if (leaf && !this.plugin.isSessionView(leaf)) {
      // A tab Obsidian hasn't loaded yet: its title lives in its saved state.
      try {
        await this.plugin.updateSavedSession(leaf, (s) => {
          if (!s.sessionTitle) return false;
          s.sessionTitle = newTitle;
          return true;
        });
      } catch { /* best effort */ }
    }
    if (leaf && this.plugin.isSessionView(leaf)) {
      // isSessionView just said the leaf has a session.
      const view = this.plugin.sessionOf(leaf) as Session;
      view.sessionTitle = newTitle;
      leaf.updateHeader?.();
      view.refreshStripTitle?.();
      this.app.workspace.requestSaveLayout();
      // Push the name into Claude's own session too (`/rename`), so its /resume
      // picker and anything reading the transcript show it. Codex and Antigravity
      // have no equivalent. Never into a prompt holding an unsent draft.
      if (view.running && view.getBackendKey() === "claude") {
        if (view.hasPendingInput()) {
          new import_obsidian.Notice("Renamed here, but not in Claude: you have unsent text in that session's prompt.", INPUT_GUARD_NOTICE_MS);
        } else if (view.programState === "waiting" || view._dialogShowing?.()) {
          // A permission prompt or a menu: the command's Enter would answer it.
          new import_obsidian.Notice("Renamed here, but not in Claude: the session is asking you something. Answer it, then rename again to update Claude.", INPUT_GUARD_NOTICE_MS);
        } else {
          void view.submitLine(`/rename ${newTitle}`);
        }
      }
    }
    return true;
  }
  // Open (or focus, if already open) a vault file in a markdown leaf — never replaces the
  // terminal leaf. Mirrors the leaf-selection logic in toggleFocus().
  async openVaultFile(this: SessionActionHost, file: TFile): Promise<void> {
    const mdLeaves = this.app.workspace.getLeavesOfType("markdown");
    const already = mdLeaves.find((l) => l.view?.file?.path === file.path);
    if (already) {
      this.app.workspace.setActiveLeaf(already, { focus: true });
      return;
    }
    const target = mdLeaves.filter((l) => !l.pinned)[0] || mdLeaves[0];
    if (target) {
      await target.openFile(file);
      this.app.workspace.setActiveLeaf(target, { focus: true });
    } else {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }
}
export { SessionActionMethods };
export type { SessionActionHost };
