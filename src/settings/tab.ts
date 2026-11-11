
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, isBackendKey } from "../constants/backends.js";
import { DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_NEW_BUTTON_NAME, DEFAULT_NEW_TICKET_BUTTON_NAME, DEFAULT_OPENING, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, NAME_LABELS, OPENING_LABELS } from "../constants/names.js";
import { DEFAULT_SCHEDULED_FOLDER, DEFAULT_TASK_TEMPLATE } from "../constants/scheduled.js";
import { PHASE_LABEL, SAFETY_NOTE, SAFETY_PHASES } from "../scheduled/safety-core.js";
import { AgentModal, FileSuggest, FolderSuggest } from "../ui/modals.js";
import { AGENTS } from "../vault-terminal/agents";
import { agentSettings, agentVariableSettings, appearanceSettings, linkSettings, notificationSettings, pythonSettings, type NotificationRows } from "../vault-terminal/settings";
import { isArray, stringOf } from "../util/guards.js";
import { DEFAULT_AGENT_DAILY_NAME, agentNameProblem, parseHome } from "../context/agents.js";
import type { AgentDef } from "../context/agents.js";
import type { App } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import { notice } from "../vault-terminal/notice";
class AgentManagerSettingsTab extends import_obsidian.PluginSettingTab {
  declare plugin: AgentManagerPlugin;
  constructor(app: App, plugin: AgentManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  override display(): void {
    this.drawSettings();
  }
  drawSettings(): void {
    const { containerEl } = this;
    const scroller = containerEl.closest<HTMLElement>(".vertical-tab-content-container") ?? containerEl;
    const top = scroller.scrollTop;
    const own = containerEl.scrollTop;
    containerEl.empty();
    this.displayGeneral(containerEl);
    this.displayContext(containerEl);
    this.displayAgentList(containerEl);
    this.displayScheduled(containerEl);
    this.displayNotifications(containerEl);
    this.displayAgents(containerEl);
    const core = this.plugin.terminal;
    if (core) {
      new import_obsidian.Setting(containerEl).setName("Terminal").setHeading();
      appearanceSettings(containerEl, core);
      linkSettings(containerEl, core);
      new import_obsidian.Setting(containerEl)
        .setName("Open notes in")
        .setDesc("Where a note clicked in a session opens: in the tab that's showing (with notes split in two, the one you were last in; never a session or a terminal), or in a new tab at the end of the tabs. A note that's already open goes to its tab either way, and a pinned tab gets a new tab instead.")
        .addDropdown((drop) => drop
          .addOption("last", "The tab that's showing")
          .addOption("new", "A new tab")
          .setValue(this.plugin.pluginData.notesOpenIn === "new" ? "new" : "last")
          .onChange(async (value) => {
            if (value === "new") this.plugin.pluginData.notesOpenIn = "new"; else delete this.plugin.pluginData.notesOpenIn;
            await this.save();
          }));
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
      try { view.renderBrowser(); } catch { /* empty */ }
    }
  }
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
      .setDesc("What a new session runs until you pick another in the sidebar, and what a ticket with no CLI set starts on. Starting from a note or a folder offers it first. Lists the CLIs that are enabled below.")
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
            notice(`There's no folder “${v}” in this vault.`);
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
      .setName("Show the new session button")
      .setDesc("A row in the sidebar, under the daily chat button, that opens a card for naming and starting a session. Turned off, sessions still start from the command palette, a note's or folder's menu, and the daily chat button.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.newButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.newButton; else this.plugin.pluginData.newButton = false;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.newButton !== false) this.textSetting(containerEl, "newButtonName", "New session button name", "What the row says, after its icon.", DEFAULT_NEW_BUTTON_NAME, () => this.rerenderSidebars());
    this.displayCustomButton(containerEl);
    new import_obsidian.Setting(containerEl)
      .setName("Show the daily chat button")
      .setDesc("A button at the top of the sidebar that opens today's chat, resuming or starting it.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.dailyChatButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.dailyChatButton; else this.plugin.pluginData.dailyChatButton = false;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.dailyChatButton !== false) new import_obsidian.Setting(containerEl)
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
      .setName("Keep unsent text through a reload")
      .setDesc("Text typed into a session and not sent is saved with its tab, in this vault's workspace file, and put back in the prompt after Obsidian or the plugin reloads. Claude Code and Codex sessions only, for now: Antigravity's prompt doesn't work with it. Turned off, nothing is saved, and each tab drops what it saved (a tab not opened since Obsidian started, when it's next opened).")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.keepDrafts !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.keepDrafts; else this.plugin.pluginData.keepDrafts = false;
          await this.save();
          this.app.workspace.requestSaveLayout();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.keepDrafts !== false) new import_obsidian.Setting(containerEl)
      .setName("Copy unsent text that can't be put back")
      .setDesc("When saved text can't go back in the prompt (you typed first, or the session asked a question or didn't start), copy it to the clipboard, replacing what's there. Turned off, it's dropped, and a notification says so.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.draftClipboard === true)
        .onChange(async (value) => {
          if (value) this.plugin.pluginData.draftClipboard = true; else delete this.plugin.pluginData.draftClipboard;
          await this.save();
        }));
    new import_obsidian.Setting(containerEl)
      .setName("Added folders")
      .setDesc("Folders outside the vault that every session can read and write, one per line, such as a code repository. A leading ~ is your home folder. A folder that isn't on this machine is skipped. Applies to new sessions.")
      .addTextArea((text) => {
        text.setPlaceholder("~/Code/my-project").setValue(this.plugin.addedFolderSetting().join("\n"));
        text.inputEl.addEventListener("change", () => { void (async () => {
          this.plugin.pluginData.addedFolders = String(text.inputEl.value || "").split("\n").map((l) => l.trim()).filter(Boolean);
          await this.save();
        })(); });
      });
  }
  displayContext(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Project overviews").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use project overviews")
      .setDesc("A folder with a project overview note is a project. A session started from a note or a folder is first told to read every project overview from the AGENTS.md folder down to it, broadest first, and the repo the nearest one names in its repo property. Tickets build on them, so turning tickets on turns these on too.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.overviewsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useOverviews = value;
          await this.save();
          this.drawSettings();
        }));
    if (this.plugin.overviewsOn()) {
      this.textSetting(containerEl, "overviewName", "Project overview file name", "The note in a folder that describes its project.", DEFAULT_OVERVIEW_NAME);
      this.pathSetting(containerEl, "overviewTemplate", "Project overview template", "The note a new project overview is made from (the folder menu's Add a project overview). {{name}} is the folder's name. Empty is a short one built in.", "Built in");
    }
    new import_obsidian.Setting(containerEl).setName("Tickets").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use tickets")
      .setDesc("A note with type: ticket in its properties is a ticket: a session started from it is told it's a ticket, and its sessions are listed in it. Turning this on also turns on project overviews, since a ticket's session reads its project's overview, and creates a tickets base in the AGENTS.md folder and the ticket template, where they're missing.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.ticketsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useTickets = value;
          if (value) this.plugin.pluginData.useOverviews = true;
          await this.save();
          if (value) await this.plugin.ensureTicketFiles();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (!this.plugin.ticketsOn()) return;
    this.pathSetting(containerEl, "ticketTemplate", "Ticket template", "The note a new ticket is made from. It's never counted as a ticket itself.", DEFAULT_TICKET_TEMPLATE);
    this.pathSetting(containerEl, "ticketsNote", "Tickets note", "The note or base the Open tickets command opens, and the sidebar's custom button unless it's set to something else: such as a dashboard that embeds the tickets base. Empty is the tickets base in the AGENTS.md folder.", "Tickets.base", () => this.rerenderSidebars());
    new import_obsidian.Setting(containerEl)
      .setName("Show the new ticket button")
      .setDesc("A row in the sidebar, under new session, that opens a card for making a ticket: its name, its project, notes, and the CLI it starts on. While agent profiles are on, it offers the switched profile's projects.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.newTicketButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.newTicketButton; else this.plugin.pluginData.newTicketButton = false;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.newTicketButton === false) return;
    this.textSetting(containerEl, "newTicketButtonName", "New ticket button name", "What the row says, after its icon.", DEFAULT_NEW_TICKET_BUTTON_NAME, () => this.rerenderSidebars());
    new import_obsidian.Setting(containerEl)
      .setName("Show the launch button on the new ticket card")
      .setDesc("A second button on the new ticket card that makes the ticket and starts its main session on the CLI picked, named for the ticket. The first only makes the ticket and opens it.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.ticketLaunchButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.ticketLaunchButton; else this.plugin.pluginData.ticketLaunchButton = false;
          await this.save();
          this.rerenderSidebars();
        }));
    this.textSetting(containerEl, "ticketNotesHeading", "Where the card's notes go", "A heading in the ticket template for the new ticket card's notes to go under, written as it is in the template, such as ## Notes. Empty, or a heading the template doesn't have, puts them first, right under the properties.", "Under the properties");
  }
  displaySafety(containerEl: HTMLElement): void {
    const results = this.plugin.safetyResults();
    const shown = SAFETY_PHASES.filter((p) => results[p]);
    const last = shown.map((p) => results[p]!).sort((a, b) => b.at - a.at)[0];
    const running = !!this.plugin._safetyRun;
    const lastLine = running ? "Checking now…" : last ? `Last checked ${new Date(last.at).toLocaleString()}, on Claude Code ${last.version || "unknown"}: ${shown.map((p) => `${PHASE_LABEL[p].toLowerCase()} ${results[p]!.outcome}${results[p]!.version && results[p]!.version !== last.version ? ` (on ${results[p]!.version})` : ""}`).join(", ")}.` : "Never checked on this computer.";
    new import_obsidian.Setting(containerEl)
      .setName("Check run safety")
      .setDesc(`Runs the gates on the Claude Code installed here, to show a scheduled run is as locked down as the plugin means it: only the tools it's given, no MCP servers, no hooks, no project settings, writes only into its own folder, never-read files refused, no network for a shell, and the Keychain command refused. Each check is a short Claude run on Haiku for each phase it checks (locked down and the shell, and a continued session or a shell with writes when a task uses them), sometimes with one retry, on your subscription, in a temporary folder that's removed after; each run leaves a Claude Code transcript. Every Keychain lookup names an entry made up for the check, never a real one. The result is also written to ${SAFETY_NOTE} in the scheduled tasks folder. ${lastLine}`)
      .addButton((b) => b
        .setButtonText(running ? "Checking…" : "Check now")
        .setDisabled(running)
        .onClick(() => {
          void (async () => {
            const phases = await this.plugin.safetyPhasesWanted();
            const go = this.plugin.runSafetyCheck(phases, { manual: true });
            this.drawSettings();
            await go;
            this.drawSettings();
          })();
        }));
    if (shown.length && !running) {
      const list = containerEl.createDiv({ cls: "agent-manager-safety-results" });
      for (const p of shown) {
        const r = results[p]!;
        const head = list.createDiv({ cls: `agent-manager-safety-phase is-${r.outcome.replace(/\W+/g, "-")}` });
        head.setText(`${PHASE_LABEL[p]}: ${r.outcome}${r.why ? ` (${r.why})` : ""}`);
        const cases = [...r.cases].sort((a, b) => (a.result === "fail" ? -1 : 0) - (b.result === "fail" ? -1 : 0));
        for (const c of cases) {
          const row = list.createDiv({ cls: `agent-manager-safety-case is-${c.result.replace(/\W+/g, "-")}` });
          row.createSpan({ cls: "agent-manager-safety-mark", text: c.result === "pass" ? "Pass" : c.result === "fail" ? "Fail" : "Not tried" });
          row.createSpan({ text: ` ${c.label}${c.detail ? `. ${c.detail}` : ""}` });
        }
      }
    }
    new import_obsidian.Setting(containerEl)
      .setName("Check run safety when Claude Code updates")
      .setDesc("Off unless you turn it on, and kept on this computer only. On, the plugin runs the check on its own, on your subscription, before the first scheduled run on a Claude Code version that hasn't passed, and scheduled runs wait until it passes; if it fails, the tasks it covers are held (one notification, naming what failed) until a check passes. Run now waits for it too, and asks before running a held task. To know when Claude Code has updated, the plugin asks Claude Code for its version number before each scheduled run and when the tasks' page opens; that's the only thing it runs without a check being due.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.safetyAutoOn())
        .onChange((value) => { this.plugin.setSafetyAutoOn(value); }));
  }
  displayScheduled(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Scheduled tasks").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use scheduled tasks")
      .setDesc("A note with type: scheduled task in its properties, in a folder of its own, is a prompt Claude Code runs on a schedule with nobody watching: as a full session in a tab, with your own settings, less sending, password lookups, and what the task denies; or headless, locked down to what its task allows, writing only its own result. Nothing runs until you approve it on this computer. The sidebar has a row that opens their page.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.scheduledTasksOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useScheduledTasks = value;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (!this.plugin.scheduledTasksOn()) return;
    new import_obsidian.Setting(containerEl)
      .setName("Run scheduled tasks on this computer")
      .setDesc("Kept on this computer only, not in the vault. Runs happen only while Obsidian is open and the computer is awake, and each task runs only once you've approved what it can reach here. Turn this on in one computer only, or both would run every task.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.schedulerOn())
        .onChange((value) => { this.plugin.setSchedulerOn(value); }));
    new import_obsidian.Setting(containerEl)
      .setName("Scheduled tasks folder")
      .setDesc("Where the new task card puts new tasks. With agent profiles off, every new task goes here. With them on, a new task goes in a Scheduled Tasks folder inside the folder of the agent you've switched to, and comes here only when that agent has no folder set. Empty means a Scheduled Tasks folder at the top of the vault. A task runs wherever it is; this only decides where new ones go.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SCHEDULED_FOLDER).setValue(stringOf(this.plugin.pluginData.scheduledFolder || ""));
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim().replace(/^\/+|\/+$/g, "");
          if (v && !v.split("/").includes("..")) this.plugin.pluginData.scheduledFolder = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData.scheduledFolder;
          await this.save();
        })(); });
      });
    this.pathSetting(containerEl, "taskTemplate", "Task template", "The note a new task is made from. It's never counted as a task itself.", DEFAULT_TASK_TEMPLATE, () => this.plugin.resetTaskIndex());
    new import_obsidian.Setting(containerEl)
      .setName("Never let a run read")
      .setDesc("Folders and files no run may read, whatever its task allows, one per line. For something in the vault, write its path from the top of the vault with no slash in front: just Private for a folder there, or Work/Private for one inside another. For somewhere else on this computer, start with ~ for your home folder (~/Documents) or / for the full path. Credentials, other apps' and plugins' settings, and other sessions' records are never read already.")
      .addTextArea((area) => {
        area.setPlaceholder("Private").setValue(this.plugin.neverReadSetting().join("\n"));
        area.inputEl.rows = 4;
        area.inputEl.addEventListener("change", () => { void (async () => {
          const lines = String(area.inputEl.value || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          if (lines.length) this.plugin.pluginData.neverRead = lines; else delete this.plugin.pluginData.neverRead;
          await this.save();
          this.rerenderSidebars();
        })(); });
      });
    this.displaySafety(containerEl);
    const sched = this.plugin.schedSettings();
    const setSched = async (patch: Record<string, unknown>) => {
      const raw = this.plugin.pluginData.scheduler;
      this.plugin.pluginData.scheduler = { ...(raw && typeof raw === "object" ? raw : {}), ...patch };
      await this.save();
    };
    new import_obsidian.Setting(containerEl)
      .setName("Commit each run's result")
      .setDesc("When the vault is a Git repository, each run's result, its run log, its memory, and a full session run's action log are committed, with Git's hooks off.")
      .addToggle((toggle) => toggle.setValue(sched.commitRuns).onChange(async (value) => { await setSched({ commitRuns: value }); }));
    new import_obsidian.Setting(containerEl)
      .setName("Runs at once")
      .setDesc("The most tasks that run at the same time. A task that's due waits for a free one.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(sched.runsAtOnce));
        text.inputEl.addEventListener("change", () => { void setSched({ runsAtOnce: Math.max(1, Math.floor(Number(text.inputEl.value)) || 3) }); });
      });
    new import_obsidian.Setting(containerEl)
      .setName("Time limit per run")
      .setDesc("In minutes. A run still going then is stopped and logged as timed out.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(sched.timeLimitMin));
        text.inputEl.addEventListener("change", () => { void setSched({ timeLimitMin: Math.max(1, Math.floor(Number(text.inputEl.value)) || 30) }); });
      });
    new import_obsidian.Setting(containerEl)
      .setName("Results in Latest Outputs")
      .setDesc("How many of the newest results, across every task, Latest Outputs lists. Older ones stay in each task's own folder.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(sched.latestOutputs));
        text.inputEl.addEventListener("change", () => { void setSched({ latestOutputs: Math.max(1, Math.floor(Number(text.inputEl.value)) || 50) }); });
      });
  }
  displayNotifications(containerEl: HTMLElement): void {
    const core = this.plugin.terminal;
    if (!core) return;
    new import_obsidian.Setting(containerEl)
      .setName("Notifications")
      .setDesc("A \"needs you\" notification is for something that broke or won't continue until you look at it. An information notice is for what's happening: what you just did, a session moved, a run that went fine. A session's questions, permission prompts, errors, and finished turns are built and tested for Claude Code sessions; Codex and Antigravity sessions aren't tested yet.")
      .setHeading();
    const scheduled = (el: HTMLElement, row: NotificationRows) => {
      if (!this.plugin.scheduledTasksOn()) return;
      const sched = this.plugin.schedSettings();
      const put = async (patch: Record<string, unknown>) => {
        const raw = this.plugin.pluginData.scheduler;
        this.plugin.pluginData.scheduler = { ...(raw && typeof raw === "object" ? raw : {}), ...patch };
        await this.save();
      };
      row(el, "When a scheduled run goes fine", "Where a notification goes when a run the schedule started finishes cleanly. One that fails, waits, stalls, or is held is a \"needs you\" notification instead. Clicking it opens the task.", "Scheduled run notification length", {
        where: sched.fineTo,
        seconds: sched.fineSeconds,
        onWhere: (v) => put({ fineTo: v }),
        onSeconds: (v) => put({ fineSeconds: v }),
      });
    };
    notificationSettings(containerEl, core, scheduled);
  }
  displayAgentList(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Agent profiles").setHeading();
    new import_obsidian.Setting(containerEl)
      .setName("Use agent profiles")
      .setDesc("Every session is an agent; a profile is who it starts as. Most vaults need none: one session can do any kind of work, and project overviews organize it by project. Profiles are for walling things off, such as work and personal, when each needs its own instructions and its own reference files, not one per role. Turned off, any added profiles are kept.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.agentsOn())
        .onChange(async (value) => {
          this.plugin.pluginData.useAgents = value;
          await this.save();
          this.rerenderSidebars();
          for (const session of this.plugin.sessionObjects()) session.refreshStripAgent();
          this.drawSettings();
        }));
    if (!this.plugin.agentsOn()) return;
    const all = this.plugin.allAgents();
    const save = async (list: AgentDef[]) => {
      this.plugin.pluginData.agents = list;
      await this.save();
      this.rerenderSidebars();
      for (const session of this.plugin.sessionObjects()) session.refreshStripAgent();
    };
    new import_obsidian.Setting(containerEl)
      .setName("Add an agent profile")
      .addButton((b) => b.setButtonText("Add").setClass("agent-manager-button").onClick(() => {
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
    const on = this.plugin.agentList();
    if (on.length) {
      new import_obsidian.Setting(containerEl)
        .setName("Default agent profile")
        .setDesc("The profile a session started from a note or folder outside every agent folder starts with, and where sessions with no agent profile are listed in the sidebar. Left at no agent profile, the sidebar's switch offers that too.")
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
            if (problem) { notice(problem); text.setValue(agent.name); return; }
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
        .setName("Agent folder")
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
  textSetting(containerEl: HTMLElement, key: "overviewName" | "newButtonName" | "newTicketButtonName" | "ticketNotesHeading" | "customButtonName" | "customButtonIcon", name: string, desc: string, placeholder: string, after?: () => void): void {
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
  pathSetting(containerEl: HTMLElement, key: "ticketsNote" | "overviewTemplate" | "ticketTemplate" | "taskTemplate", name: string, desc: string, placeholder: string, after?: () => void): void {
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
          after?.();
        })(); });
      });
  }
  displayCustomButton(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl)
      .setName("Show the custom button")
      .setDesc("A button at the top of the sidebar, under the daily chat button, that opens a note, a base, or a link. While tickets are on, it opens the tickets note unless you set it to something else; otherwise it shows once it has something to open.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.customButton !== false)
        .onChange(async (value) => {
          if (value) delete this.plugin.pluginData.customButton; else this.plugin.pluginData.customButton = false;
          await this.save();
          this.rerenderSidebars();
          this.drawSettings();
        }));
    if (this.plugin.pluginData.customButton === false) return;
    this.textSetting(containerEl, "customButtonIcon", "Custom button icon", "A Lucide icon's name, as on lucide.dev, such as ticket or layout-dashboard. Empty, or a name Obsidian doesn't have, is a ticket while it opens the tickets note, else a link.", "", () => this.rerenderSidebars());
    this.textSetting(containerEl, "customButtonName", "Custom button text", "What the button says beside its icon. Empty says Tickets while it opens the tickets note, else the name of what it opens.", "", () => this.rerenderSidebars());
    new import_obsidian.Setting(containerEl)
      .setName("Custom button opens")
      .setDesc("A note or base in this vault, or a web or Obsidian link. Empty is the tickets note while tickets are on.")
      .addText((text) => {
        text.setPlaceholder(this.plugin.ticketsOn() ? this.plugin.ticketsNotePath() : "").setValue(stringOf(this.plugin.pluginData.customButtonTarget || ""));
        new FileSuggest(this.app, text.inputEl, ["md", "base"]);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (!v) delete this.plugin.pluginData.customButtonTarget;
          else this.plugin.pluginData.customButtonTarget = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : (0, import_obsidian.normalizePath)(v);
          await this.save();
          this.rerenderSidebars();
        })(); });
      });
  }
  displayNotes(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl)
      .setName("Openings")
      .setDesc("What a new session is told first. Empty sends nothing; a resumed session and a side chat are never sent anything. {{path}} is the full path of the note or folder, {{vault}} the vault's, {{date}} today's.")
      .setHeading();
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
            if (!list.length) {
              notice("At least one CLI has to be enabled.");
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
  storedBackends(): BackendKey[] {
    const stored = this.plugin.pluginData.browserBackends;
    return (isArray(stored) && stored.length ? stored : REAL_BACKENDS).filter((k) => isBackendKey(k));
  }
  displayAdvanced(containerEl: HTMLElement): void {
    new import_obsidian.Setting(containerEl).setName("Advanced & experimental").setHeading();
    const setupName = createFragment((f) => {
      f.appendText("Set up this vault");
      f.createSpan({ cls: "agent-manager-badge", text: "Experimental" });
    });
    new import_obsidian.Setting(containerEl)
      .setName(setupName)
      .setDesc("Starts a session that helps you set this vault up for agents: an AGENTS.md, where files go, and more if you'd like. You choose whether it asks before each change or sets things up itself and reports back; either way, it asks before changing anything already in the vault. You can close it and resume it later. An AI does the work, so results vary with the CLI and model.")
      .addButton((b) => b.setButtonText("Set up").setClass("agent-manager-button").onClick(() => { void this.plugin.openVaultSetup(); }));
    if (this.plugin.terminal) pythonSettings(containerEl, this.plugin.terminal);
    if (this.storedBackends().includes("claude")) {
      new import_obsidian.Setting(containerEl)
        .setName("Show pictures Claude sends or reads")
        .setDesc("When Claude sends you a picture (with its send-file tool), or looks at one (a PNG it reads, such as a screenshot it took), it's drawn right in the session, framed, with buttons to open it, save it to your downloads folder, or copy its path. It works through a small Claude Code mod that comes with Agent Manager and is loaded only into sessions Agent Manager starts; nothing is installed in Claude Code itself. It also needs the terminal's picture setting to be on. Applies to sessions started or resumed afterwards.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.pluginData.claudePictures !== false)
          .onChange(async (value) => {
            this.plugin.pluginData.claudePictures = value;
            await this.save();
          }));
      new import_obsidian.Setting(containerEl)
        .setName("Fold tool output")
        .setDesc("Adds /quiet to Claude sessions, and a Quiet button to the strip above them: it folds each tool's output (a file edit's diff, a command's output, a file read) into one line, and back again, for the whole session at once. Only the tools that produce output fold (file edits, commands, file reads, web fetches and searches, MCP tools); what Claude writes to you stays: its text, its questions, plans, task lists, links, and subagents' reports, and any errors. The transcript is untouched, and Ctrl+O still shows everything in full. Claude Code remembers whether it's on between sessions. It needs Claude Code's fullscreen rendering (/tui fullscreen) to fold output already shown. It works through a second small Claude Code mod that comes with Agent Manager, loaded only into sessions Agent Manager starts. Applies to sessions started or resumed afterwards.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.pluginData.claudeQuietTools !== false)
          .onChange(async (value) => {
            this.plugin.pluginData.claudeQuietTools = value;
            await this.save();
          }));
      new import_obsidian.Setting(containerEl)
        .setName("Show Remote Control on the strip")
        .setDesc("A dot on a Claude session's strip: green while you can reach the session from claude.ai or the Claude app, grey while you can't, and hollow until Claude says. Claude reports it after each turn, so a session that disconnects while idle shows it at its next turn. Clicking a grey dot connects the session (it types /remote-control). Claude's own Remote Control setting decides which sessions connect; this only shows it.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.pluginData.remoteControlDot !== false)
          .onChange(async (value) => {
            this.plugin.pluginData.remoteControlDot = value;
            await this.save();
            for (const s of this.plugin.sessionObjects()) s.rebuildStrip();
          }));
    }
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
