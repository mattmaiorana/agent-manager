// The plugin's settings tab: general settings first, then the openings, each CLI, the terminal, and the rarely changed ones under Advanced.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, isBackendKey } from "../constants/backends.js";
import { DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_OPENING, NAME_LABELS, OPENING_LABELS } from "../constants/names.js";
import { FolderSuggest } from "../ui/modals.js";
import { AGENTS } from "../vault-terminal/agents";
import { agentSettings, agentVariableSettings, appearanceSettings, linkSettings, pythonSettings } from "../vault-terminal/settings";
import { isArray, stringOf } from "../util/guards.js";
import type { App } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
class AgentManagerSettingsTab extends import_obsidian.PluginSettingTab {
  declare plugin: AgentManagerPlugin;
  constructor(app: App, plugin: AgentManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  // Obsidian draws the tab through display(), which its types mark deprecated in favor of
  // setting definitions (getSettingDefinitions, 1.13). The tab is still drawn by hand, so
  // its own redraws call drawSettings, which display() runs.
  override display(): void {
    this.drawSettings();
  }
  drawSettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.displayGeneral(containerEl);
    this.displayNotes(containerEl);
    this.displayAgents(containerEl);
    const core = this.plugin.terminal;
    if (core) {
      new import_obsidian.Setting(containerEl).setName("Terminal").setHeading();
      appearanceSettings(containerEl, core);
      linkSettings(containerEl, core);
    }
    this.displayAdvanced(containerEl);
  }
  async save(): Promise<void> {
    await this.plugin.savePluginData();
  }
  rerenderSidebars(): void {
    for (const view of this.plugin.browserViews()) {
      try { view.renderBrowser(); } catch { /* best effort */ }
    }
  }
  // A name setting (a folder or a property), saved on change (blur or Enter), not per
  // keystroke, since a folder name is used as it's typed.
  nameSetting(containerEl: HTMLElement, key: NameKey): void {
    const [label, desc] = NAME_LABELS[key];
    new import_obsidian.Setting(containerEl)
      .setName(label)
      .setDesc(desc)
      .addText((text) => {
        text.setPlaceholder(DEFAULT_NAMES[key]).setValue(stringOf(this.plugin.pluginData.names?.[key] || ""));
        text.inputEl.addEventListener("change", () => { void (async () => {
          const d = this.plugin.pluginData;
          d.names = d.names || {};
          const v = String(text.inputEl.value || "").trim();
          if (v && v !== DEFAULT_NAMES[key]) d.names[key] = v; else delete d.names[key];
          await this.save();
        })(); });
      });
  }
  displayGeneral(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl)
      .setName("Default CLI")
      .setDesc("What a new session runs until you pick another in the sidebar. Starting from a note or a folder offers it first.")
      .addDropdown((drop) => {
        for (const key of REAL_BACKENDS) drop.addOption(key, CLI_BACKENDS[key].label);
        drop.setValue(this.plugin.getCurrentBackend());
        drop.onChange(async (value) => {
          this.plugin.pluginData.cliBackend = value;
          await this.save();
          this.rerenderSidebars();
        });
      });
    new import_obsidian.Setting(containerEl)
      .setName("AGENTS.md folder")
      .setDesc("Where your AGENTS.md lives, and where every session starts. Claude Code, Codex, and Antigravity all read it. A session started in a folder below the vault's root isn't given the rest of the vault; what it may read or change outside the folder is up to the CLI's own permissions. Empty is the vault's root. Applies to new sessions.")
      .addText((text) => {
        text.setPlaceholder("Vault root").setValue(stringOf(this.plugin.pluginData.startFolder || ""));
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim().replace(/^\/+|\/+$/g, "");
          if (v && !(this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(v)) instanceof import_obsidian.TFolder)) {
            new import_obsidian.Notice(`There's no folder “${v}” in this vault.`);
            text.setValue(stringOf(this.plugin.pluginData.startFolder || ""));
            return;
          }
          if (v) this.plugin.pluginData.startFolder = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData.startFolder;
          await this.save();
          this.plugin.invalidateSessionIndex();
          this.rerenderSidebars();
        })(); });
      });
    this.nameSetting(containerEl, "transcriptsFolder");
    new import_obsidian.Setting(containerEl)
      .setName("Daily chat name")
      .setDesc("The day's chat is found and named by this. {{date}} is today's date, as 2026-10-19.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_DAILY_NAME).setValue(stringOf(this.plugin.pluginData.dailyChatName || ""));
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (v && v !== DEFAULT_DAILY_NAME) this.plugin.pluginData.dailyChatName = v; else delete this.plugin.pluginData.dailyChatName;
          await this.save();
          this.rerenderSidebars();
        })(); });
      });
    new import_obsidian.Setting(containerEl)
      .setName("Keep sessions in their own split")
      .setDesc("Session tabs open in a tab group of their own on the right, and notes never open there.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.dedicatedTerminalSplit !== false)
        .onChange(async (value) => {
          this.plugin.pluginData.dedicatedTerminalSplit = value;
          await this.save();
        }));
    new import_obsidian.Setting(containerEl)
      .setName("Added folders")
      .setDesc("Folders outside the vault that every session can read and write, one per line, such as a code repository. A leading ~ is your home folder. A folder that isn't on this machine is skipped. Applies to new sessions.")
      .addTextArea((text) => text
        .setPlaceholder("~/Code/my-project")
        .setValue(this.plugin.addedFolderSetting().join("\n"))
        .onChange(async (value) => {
          this.plugin.pluginData.addedFolders = value.split("\n").map((l) => l.trim()).filter(Boolean);
          await this.save();
        }));
  }
  // What a new session is told first.
  displayNotes(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl)
      .setName("Openings")
      .setDesc("What a new session is told first. Empty sends nothing; a resumed session and a side chat are never sent anything. {{path}} is the full path of the note or folder, {{vault}} the vault's, {{date}} today's.")
      .setHeading();
    // DEFAULT_OPENING has exactly the OpeningKeys.
    for (const key of Object.keys(DEFAULT_OPENING) as OpeningKey[]) {
      const [label, desc] = OPENING_LABELS[key];
      const setting = new import_obsidian.Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addTextArea((text) => {
          text.setValue(this.plugin.openingPart(key));
          text.inputEl.rows = 3;
          text.inputEl.addEventListener("change", () => { void (async () => {
            const d = this.plugin.pluginData;
            d.opening = d.opening || {};
            d.opening[key] = text.inputEl.value;
            await this.save();
          })(); });
        })
        .addExtraButton((btn) => btn
          .setIcon("rotate-ccw")
          .setTooltip("Restore the default")
          .onClick(async () => {
            if (this.plugin.pluginData.opening) delete this.plugin.pluginData.opening[key];
            await this.save();
            this.drawSettings();
          }));
      setting.settingEl.addClass("agent-manager-env-setting");
    }
  }
  // Each CLI: offered or not (and whether it's installed), its command and location.
  displayAgents(containerEl: HTMLElement): void {
    const status = this.plugin.setupStatus();
    const core = this.plugin.terminal;
    for (const key of REAL_BACKENDS) {
      const backend = CLI_BACKENDS[key];
      new import_obsidian.Setting(containerEl).setName(backend.label).setHeading();
      const desc = createFragment((f) => {
        if (!status) f.appendText("Checking whether it's installed…");
        else if (status.installed[key]) f.appendText("Installed. Offered for new sessions in the sidebar and the file menu.");
        else {
          f.appendText("Not found. To install it, run this in Terminal, then sign in to it there once:");
          f.createEl("code", { cls: "agent-manager-setup-cmd", text: backend.install });
        }
      });
      const offer = new import_obsidian.Setting(containerEl)
        .setName("Offer for new sessions")
        .setDesc(desc)
        .addToggle((toggle) => toggle
          .setValue(this.storedBackends().includes(key))
          .onChange(async (value) => {
            let list = this.storedBackends();
            list = value ? REAL_BACKENDS.filter((k) => k === key || list.includes(k)) : list.filter((k) => k !== key);
            // At least one stays offered, or nothing could start a session.
            if (!list.length) {
              new import_obsidian.Notice("At least one CLI has to be offered.");
              toggle.setValue(true);
              return;
            }
            this.plugin.pluginData.browserBackends = list;
            await this.save();
            this.rerenderSidebars();
          }));
      if (status && !status.installed[key]) {
        offer.addExtraButton((btn) => btn
          .setIcon("rotate-cw")
          .setTooltip("Check again")
          .onClick(async () => {
            await this.plugin.checkSetup(true);
            this.drawSettings();
          }));
      }
      const agent = AGENTS.find((a) => a.id === key);
      if (core && agent) agentSettings(containerEl, core, agent);
      if (key === "codex") {
        new import_obsidian.Setting(containerEl)
          .setName("Run on Codex's background server")
          .setDesc("Off: every Codex session, new or resumed, runs on its own. On: Codex sessions run on Codex's background server. Applies to sessions started or resumed afterwards. A conversation last opened one way may refuse the other, saying it's open in another app, until Codex's server lets it go.")
          .addToggle((toggle) => toggle
            .setValue(this.plugin.pluginData.codexServer === true)
            .onChange(async (value) => {
              this.plugin.pluginData.codexServer = value;
              await this.save();
            }));
      }
    }
    if (core) {
      new import_obsidian.Setting(containerEl).setName("Agent environment").setHeading();
      agentVariableSettings(containerEl, core);
    }
  }
  // The offered list as stored (all three until it's edited), before the installed filter.
  storedBackends(): BackendKey[] {
    const stored = this.plugin.pluginData.browserBackends;
    return (isArray(stored) && stored.length ? stored : REAL_BACKENDS).filter((k) => isBackendKey(k));
  }
  displayAdvanced(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Advanced").setHeading();
    if (this.plugin.terminal) pythonSettings(containerEl, this.plugin.terminal);
    new import_obsidian.Setting(containerEl)
      .setName("Load every session tab on restart")
      .setDesc("Off: Obsidian restores session tabs unloaded, and each resumes when you open it. On: every restored session resumes at once, so they're running (and reachable through Claude's Remote Control) right after a restart, at the cost of a slower start.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.eagerLoadOnRestart === true)
        .onChange(async (value) => {
          this.plugin.pluginData.eagerLoadOnRestart = value;
          await this.save();
        }));
    new import_obsidian.Setting(containerEl)
      .setName("Show the name on the sidebar tab")
      .setDesc("Show “Agent Manager” beside the sidebar tab's icon.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.showSidebarTitle === true)
        .onChange(async (value) => {
          this.plugin.pluginData.showSidebarTitle = value;
          await this.save();
          this.plugin.applySidebarTitleClass();
        }));
  }
}
export { AgentManagerSettingsTab };
