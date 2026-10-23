// The plugin's settings tab: general settings first, then the openings, each CLI, the terminal, and the rarely changed ones under Advanced.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, isBackendKey } from "../constants/backends.js";
import { DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_OPENING, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, NAME_LABELS, OPENING_LABELS } from "../constants/names.js";
import { AgentModal, FileSuggest, FolderSuggest } from "../ui/modals.js";
import { AGENTS } from "../vault-terminal/agents";
import { agentSettings, agentVariableSettings, appearanceSettings, linkSettings, pythonSettings } from "../vault-terminal/settings";
import { isArray, stringOf } from "../util/guards.js";
import { DEFAULT_AGENT_DAILY_NAME, agentNameProblem, parseHome } from "../context/agents.js";
import type { AgentDef } from "../context/agents.js";
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
  // A redraw (a switch that shows or hides settings) keeps the scroll position, so the
  // page doesn't jump to the top under the click.
  drawSettings(): void {
    const { containerEl } = this;
    const scroller = containerEl.closest<HTMLElement>(".vertical-tab-content-container") ?? containerEl;
    const top = scroller.scrollTop;
    const own = containerEl.scrollTop;
    containerEl.empty();
    this.displayGeneral(containerEl);
    this.displayContext(containerEl);
    this.displayAgentList(containerEl);
    this.displayAgents(containerEl);
    const core = this.plugin.terminal;
    if (core) {
      new import_obsidian.Setting(containerEl).setName("Terminal").setHeading();
      appearanceSettings(containerEl, core);
      linkSettings(containerEl, core);
    }
    this.displayNotes(containerEl);
    this.displayAdvanced(containerEl);
    scroller.scrollTop = top;
    containerEl.scrollTop = own;
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
        new FolderSuggest(this.app, text.inputEl);
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
      .setName("Default backend (CLI)")
      .setDesc("What a new session runs until you pick another in the sidebar, and what a ticket with no backend property starts on. Starting from a note or a folder offers it first. Lists the CLIs that are enabled below.")
      .addDropdown((drop) => {
        const enabled = this.plugin.getBrowserBackends();
        for (const key of enabled) drop.addOption(key, CLI_BACKENDS[key].label);
        const current = this.plugin.getCurrentBackend();
        drop.setValue(enabled.includes(current) ? current : enabled[0]);
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
      .setDesc("The day's chat is found and named by this. {{date}} is today's date, as 2026-10-19. Once there are agent profiles, each one's own daily chat name is used instead.")
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
      .setName("Wrap message")
      .setDesc("Exactly what the wrap button types into the session. To run a skill instead, put its command here, such as /wrap for a skill named wrap. In Codex sessions the plugin rewrites /wrap as $wrap, the form Codex needs. Empty hides the button.")
      .addTextArea((text) => {
        text.setValue(this.plugin.wrapMessage());
        text.inputEl.rows = 2;
        text.inputEl.addEventListener("change", () => { void (async () => {
          this.plugin.pluginData.wrapMessage = text.inputEl.value.trim();
          await this.save();
        })(); });
      })
      .addExtraButton((btn) => btn
        .setIcon("rotate-ccw")
        .setTooltip("Restore the default")
        .onClick(async () => {
          delete this.plugin.pluginData.wrapMessage;
          await this.save();
          this.drawSettings();
        }));
    new import_obsidian.Setting(containerEl)
      .setName("Save generated files")
      .setDesc("A file a Claude Code session sends you (with its send-file tool) is copied into the vault and shown in the session's transcript note. By default it goes where Obsidian puts a new attachment for the note the session was started from, as set in Obsidian's own settings. Codex and Antigravity have no such tool; a file they make is written where you ask for it.")
      .addDropdown((drop) => {
        drop.addOption("obsidian", "Where Obsidian puts attachments");
        drop.addOption("own", "In a folder set here");
        drop.addOption("off", "Don't save them");
        const v = this.plugin.pluginData.sentFiles;
        drop.setValue(v === "own" || v === "off" ? v : "obsidian");
        drop.onChange(async (value) => {
          if (value === "obsidian") delete this.plugin.pluginData.sentFiles; else this.plugin.pluginData.sentFiles = value;
          await this.save();
          this.drawSettings();
        });
      });
    if (this.plugin.pluginData.sentFiles === "own") {
      new import_obsidian.Setting(containerEl)
        .setName("Folder for sent files")
        .setDesc("A folder in the vault. Start it with ./ to put it beside the note the session was started from.")
        .addText((text) => {
          text.setPlaceholder("./Files").setValue(stringOf(this.plugin.pluginData.sentFilesFolder || ""));
          new FolderSuggest(this.app, text.inputEl);
          text.inputEl.addEventListener("change", () => { void (async () => {
            const v = String(text.inputEl.value || "").trim();
            if (v) this.plugin.pluginData.sentFilesFolder = v; else delete this.plugin.pluginData.sentFilesFolder;
            await this.save();
          })(); });
        });
    }
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
  // Overviews and tickets: both off until switched on, and each one's own settings shown
  // only while it's on.
  displayContext(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Overviews").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use overviews")
      .setDesc("A folder with an overview note is a project. A session started from a note or a folder is first told to read every overview from the AGENTS.md folder down to it, broadest first, and the repo the nearest one names in its repo property.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.overviewsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useOverviews = value;
          await this.save();
          this.drawSettings();
        }));
    if (this.plugin.overviewsOn()) {
      this.textSetting(containerEl, "overviewName", "Overview file name", "The note in a folder that describes it.", DEFAULT_OVERVIEW_NAME);
      this.pathSetting(containerEl, "overviewTemplate", "Overview template", "The note a new overview is made from (the folder menu's Add an overview). {{name}} is the folder's name. Empty is a short one built in.", "Built in");
    }
    new import_obsidian.Setting(containerEl).setName("Tickets").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use tickets")
      .setDesc("A note with type: ticket in its properties is a ticket: a session started from it is told it's a ticket, and its sessions are listed in it. Turning this on creates a tickets base in the AGENTS.md folder and the ticket template, where they're missing.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.ticketsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useTickets = value;
          await this.save();
          if (value) await this.plugin.ensureTicketFiles();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (!this.plugin.ticketsOn()) return;
    this.pathSetting(containerEl, "ticketTemplate", "Ticket template", "The note a new ticket is made from. It's never counted as a ticket itself.", DEFAULT_TICKET_TEMPLATE);
    new import_obsidian.Setting(containerEl)
      .setName("Show the tickets button")
      .setDesc("A button at the top of the sidebar that opens your tickets.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.ticketsButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.ticketsButton; else this.plugin.pluginData.ticketsButton = false;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.ticketsButton === false) return;
    this.textSetting(containerEl, "ticketsButtonName", "Tickets button name", "What the button says.", "Tickets", () => this.rerenderSidebars());
    this.pathSetting(containerEl, "ticketsNote", "Tickets button opens", "The note or base the button opens, such as a dashboard that embeds the tickets base. Empty is the tickets base in the AGENTS.md folder.", "Tickets.base");
  }
  // Agents: none until one is added. Add an agent and the Default agent first, then each
  // agent's name, instructions note, home folder, and Daily Chat name.
  displayAgentList(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Agent profiles").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use agent profiles")
      .setDesc("Every session is an agent; a profile is who it starts as. Most vaults need none: one session can do any kind of work, and overviews organize it by project. Profiles are for walling things off, such as work and personal, when each needs its own instructions and its own reference files, not one per role. Turned off, the profiles are kept.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.agentsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useAgents = value;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (!this.plugin.agentsOn()) return;
    const all = this.plugin.allAgents();
    const save = async (list: AgentDef[]) => {
      this.plugin.pluginData.agents = list;
      await this.save();
      this.rerenderSidebars();
    };
    new import_obsidian.Setting(containerEl)
      .setName("Add an agent profile")
      .addButton((b) => b.setButtonText("Add").onClick(() => {
        new AgentModal(this.app, (name) => agentNameProblem(name, this.plugin.allAgents().map((a) => a.name)), async (f) => {
          const home = parseHome(f.home);
          const list = this.plugin.allAgents();
          list.push({
            id: this.plugin.newSessionId(),
            name: f.name.trim(),
            instructions: f.instructions.trim() ? (0, import_obsidian.normalizePath)(f.instructions.trim()) : "",
            home: home ? (0, import_obsidian.normalizePath)(home) : home,
            dailyName: f.dailyName.trim(),
            enabled: true,
          });
          await save(list);
          this.drawSettings();
        }, DEFAULT_AGENT_DAILY_NAME).open();
      }));
    // While there are agents on: it decides where sessions with none are listed.
    const on = this.plugin.agentList();
    if (on.length) {
      new import_obsidian.Setting(containerEl)
        .setName("Default agent profile")
        .setDesc("The profile a session started from a note or folder outside every home folder starts with, and where sessions with no agent profile are listed in the sidebar. Left at no agent profile, the sidebar's switch offers that too.")
        .addDropdown((dd) => {
          dd.addOption("", "No agent profile");
          for (const a of on) dd.addOption(a.id, a.name);
          dd.setValue(this.plugin.defaultAgent()?.id || "");
          dd.onChange(async (value) => {
            if (value) this.plugin.pluginData.defaultAgent = value; else delete this.plugin.pluginData.defaultAgent;
            await this.save();
            this.rerenderSidebars();
          });
        });
    }
    all.forEach((agent, index) => {
      const update = async (change: Partial<AgentDef>) => {
        const list = this.plugin.allAgents();
        const i = list.findIndex((a) => a.id === agent.id);
        if (i === -1) return;
        list[i] = { ...list[i], ...change };
        await save(list);
      };
      // Its heading row: on or off, move up, remove. Off hides its settings and keeps them.
      const head = new import_obsidian.Setting(containerEl)
        .setName(agent.name)
        .setClass("agent-manager-agent-head");
      if (!agent.enabled) head.setDesc("Off: its settings are kept. Its sessions are listed as if they had no agent profile.");
      if (index > 0) head.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Move up").onClick(async () => {
        const list = this.plugin.allAgents();
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
        await save(list);
        this.drawSettings();
      }));
      head.addExtraButton((b) => b.setIcon("trash").setTooltip("Remove this agent profile").onClick(async () => {
        await save(this.plugin.allAgents().filter((a) => a.id !== agent.id));
        if (this.plugin.pluginData.defaultAgent === agent.id) delete this.plugin.pluginData.defaultAgent;
        if (this.plugin.pluginData.currentAgent === agent.id) delete this.plugin.pluginData.currentAgent;
        await this.save();
        this.rerenderSidebars();
        this.drawSettings();
      }));
      head.addToggle((t) => t.setTooltip(agent.enabled ? "Turn this agent profile off" : "Turn this agent profile on").setValue(agent.enabled).onChange(async (value) => {
        await update({ enabled: value });
        this.drawSettings();
      }));
      if (!agent.enabled) return;
      new import_obsidian.Setting(containerEl)
        .setName("Name")
        .setDesc("Its transcripts go in a folder of this name in the transcripts folder.")
        .addText((text) => {
          text.setValue(agent.name);
          text.inputEl.addEventListener("change", () => { void (async () => {
            const name = text.inputEl.value.trim();
            if (name === agent.name) return;
            const problem = agentNameProblem(name, this.plugin.allAgents().filter((a) => a.id !== agent.id).map((a) => a.name));
            if (problem) { new import_obsidian.Notice(problem); text.setValue(agent.name); return; }
            await update({ name });
            await this.plugin.renameAgentFiles(agent.name, name);
            this.drawSettings();
          })(); });
        });
      new import_obsidian.Setting(containerEl)
        .setName("Instructions note")
        .setDesc("The note that says who this agent profile is and how it works.")
        .addText((text) => {
          text.setPlaceholder("Agents/Personal.md").setValue(agent.instructions);
          new FileSuggest(this.app, text.inputEl, ["md"]);
          text.inputEl.addEventListener("change", () => { void update({ instructions: text.inputEl.value.trim() ? (0, import_obsidian.normalizePath)(text.inputEl.value.trim()) : "" }); });
        });
      new import_obsidian.Setting(containerEl)
        .setName("Home folder")
        .setDesc("A session started from a note or folder in here starts with this agent profile. Empty for none; / for the whole vault.")
        .addText((text) => {
          text.setPlaceholder("None").setValue(agent.home === null ? "" : agent.home === "" ? "/" : agent.home);
          new FolderSuggest(this.app, text.inputEl);
          text.inputEl.addEventListener("change", () => {
            const home = parseHome(text.inputEl.value);
            void update({ home: home ? (0, import_obsidian.normalizePath)(home) : home });
          });
        });
      new import_obsidian.Setting(containerEl)
        .setName("Daily chat name")
        .setDesc("This agent profile's daily chat is found and named by this. {{profile}} is its name, {{date}} today's date.")
        .addText((text) => {
          text.setPlaceholder(DEFAULT_AGENT_DAILY_NAME).setValue(agent.dailyName);
          text.inputEl.addEventListener("change", () => { void update({ dailyName: text.inputEl.value.trim() }); });
        });
    });
  }
  // A text setting, saved on change (blur or Enter); empty removes it, for its default.
  textSetting(containerEl: HTMLElement, key: "overviewName" | "ticketsButtonName", name: string, desc: string, placeholder: string, after?: () => void): void {
    new import_obsidian.Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setPlaceholder(placeholder).setValue(stringOf(this.plugin.pluginData[key] || ""));
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (v && v !== placeholder) this.plugin.pluginData[key] = v; else delete this.plugin.pluginData[key];
          await this.save();
          after?.();
        })(); });
      });
  }
  // A vault path setting, saved on change (blur or Enter); empty removes it, for its default.
  pathSetting(containerEl: HTMLElement, key: "ticketsNote" | "overviewTemplate" | "ticketTemplate", name: string, desc: string, placeholder: string): void {
    new import_obsidian.Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setPlaceholder(placeholder).setValue(stringOf(this.plugin.pluginData[key] || ""));
        new FileSuggest(this.app, text.inputEl, key === "ticketsNote" ? ["md", "base"] : ["md"]);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (v) this.plugin.pluginData[key] = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData[key];
          await this.save();
        })(); });
      });
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
  // Each CLI: enabled or not (and whether it's installed), its command and location.
  displayAgents(containerEl: HTMLElement): void {
    const status = this.plugin.setupStatus();
    const core = this.plugin.terminal;
    for (const key of REAL_BACKENDS) {
      const backend = CLI_BACKENDS[key];
      new import_obsidian.Setting(containerEl).setName(backend.label).setHeading();
      const desc = createFragment((f) => {
        if (!status) f.appendText("Checking whether it's installed…");
        else if (status.installed[key]) f.appendText("Installed. While it's enabled, it's offered for new sessions in the sidebar and the file menu.");
        else {
          f.appendText("Not found. To install it, run this in Terminal, then sign in to it there once:");
          f.createEl("code", { cls: "agent-manager-setup-cmd", text: backend.install });
        }
      });
      const offer = new import_obsidian.Setting(containerEl)
        .setName("Enable")
        .setDesc(desc)
        .addToggle((toggle) => toggle
          .setValue(this.storedBackends().includes(key))
          .onChange(async (value) => {
            let list = this.storedBackends();
            list = value ? REAL_BACKENDS.filter((k) => k === key || list.includes(k)) : list.filter((k) => k !== key);
            // At least one stays enabled, or nothing could start a session.
            if (!list.length) {
              new import_obsidian.Notice("At least one CLI has to be enabled.");
              toggle.setValue(true);
              return;
            }
            this.plugin.pluginData.browserBackends = list;
            await this.save();
            this.rerenderSidebars();
            this.drawSettings();
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
      // A CLI's own settings show only while it's enabled.
      if (!this.storedBackends().includes(key)) continue;
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
