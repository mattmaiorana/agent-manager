
import { CLI_BACKENDS } from "../constants/backends.js";
import { ChoicePickerModal } from "../ui/modals.js";
import type { App, Menu, TFile } from "obsidian";
import type { CliBackend } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { Session } from "./controller.js";
import { notice } from "../vault-terminal/notice";

interface SessionActionHost {
  plugin: AgentManagerPlugin;
  app: App;
}
interface RenameTarget {
  sessionId: string | null;
  title: string;
  backend: string;
  displayName: string;
}
class SessionActionMethods {
  addMoveToAgent(this: SessionActionHost, menu: Menu, sessionId: string | null, backend: string, done?: () => void): void {
    const agents = this.plugin.agentList();
    if (!sessionId || !agents.length) return;
    menu.addItem((item) => item.setTitle("Move to agent profile…").setIcon("folder-input").onClick(() => {
      const cur = this.plugin.recordedAgentId(sessionId) ?? "";
      const choices = agents.filter((a) => a.id !== cur).map((a) => ({ id: a.id, name: a.name }));
      if (this.plugin.agentById(cur)) choices.push({ id: "", name: "No agent profile" });
      if (!choices.length) { notice("There's no other agent profile to move this session to."); return; }
      const effect = "Filed under it. The conversation itself keeps the profile it started with.";
      new ChoicePickerModal(this.app, choices, {
        placeholder: "Move this session to which agent profile?",
        label: (c) => c.name,
        sub: () => effect,
        onPick: async (c) => {
          await this.plugin.moveSessionToAgent(sessionId, c.id);
          notice(`Moved to ${c.name}. ${effect}`);
          done?.();
        },
      }).open();
    }));
  }
  appendBackendBadge(parentEl: HTMLElement, backendKey: string): HTMLElement {
    const backend = (CLI_BACKENDS as Partial<Record<string, CliBackend>>)[backendKey];
    return parentEl.createSpan({
      cls: "agent-manager-backend-badge",
      text: backend ? (backend.badge || backend.binary) : backendKey,
      attr: { "data-backend": backendKey }
    });
  }
  async applyRename(this: SessionActionHost, session: RenameTarget, rawSubject: string | null): Promise<boolean> {
    if (!session.sessionId) return false;
    const finalName = (rawSubject || "").trim();
    if (!finalName || finalName === session.displayName) return false;
    const newTitle = finalName;
    if (!this.plugin.pluginData.sessionNames) this.plugin.pluginData.sessionNames = {};
    this.plugin.pluginData.sessionNames[session.sessionId] = finalName;
    await this.plugin.savePluginData();
    this.plugin.invalidateSessionIndex();
    const leaf = this.plugin.getLeafForSession(session.title, session.backend, session.sessionId);
    if (leaf && !this.plugin.isSessionView(leaf)) {
      try {
        await this.plugin.updateSavedSession(leaf, (s) => {
          if (!s.sessionTitle) return false;
          s.sessionTitle = newTitle;
          return true;
        });
      } catch { /* empty */ }
    }
    if (leaf && this.plugin.isSessionView(leaf)) {
      const view = this.plugin.sessionOf(leaf) as Session;
      view.sessionTitle = newTitle;
      leaf.updateHeader?.();
      view.refreshStripTitle?.();
      view.resetTicketWriteback?.();
      this.app.workspace.requestSaveLayout();
      if (view.running && view.getBackendKey() === "claude") {
        if (view.hasPendingInput()) {
          view._notifyNeedsYou("Renamed here, but not in Claude: you have unsent text in that session's prompt.");
        } else if (view.programState === "waiting" || view._dialogShowing?.()) {
          view._notifyNeedsYou("Renamed here, but not in Claude: the session is asking you something. Answer it, then rename again to update Claude.");
        } else {
          void view.submitLine(`/rename ${newTitle}`);
        }
      }
    }
    return true;
  }
  async openVaultFile(this: SessionActionHost, file: TFile): Promise<void> {
    await this.plugin.openNoteFromTerminal(file);
  }

}
export { SessionActionMethods };
export type { SessionActionHost };
