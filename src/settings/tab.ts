
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, isBackendKey } from "../constants/backends.js";
import { DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_NEW_BUTTON_NAME, DEFAULT_NEW_TICKET_BUTTON_NAME, DEFAULT_OPENING, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, NAME_LABELS, OPENING_LABELS } from "../constants/names.js";
import { DEFAULT_SCHEDULED_FOLDER, DEFAULT_TASK_TEMPLATE } from "../constants/scheduled.js";
import { AgentModal, FileSuggest, FolderSuggest } from "../ui/modals.js";
import { AGENTS } from "../vault-terminal/agents";
import { agentDefinitions, agentVariableDefinitions, appearanceDefinitions, linkDefinitions, notificationDefinitions, pythonDefinitions, row, type NotificationRows } from "../vault-terminal/settings";
import { isArray, stringOf } from "../util/guards.js";
import { DEFAULT_AGENT_DAILY_NAME, DEFAULT_DASHBOARD_ICON, agentNameProblem, parseHome, profileColor, readColor } from "../context/agents.js";
import type { AgentDef } from "../context/agents.js";
import type { App, Setting, SettingDefinition, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import { notice } from "../vault-terminal/notice";
import { pageSearch } from "./page-search";

type Group = { type: "group"; heading?: string; items: (SettingDefinition | SettingDefinitionPage)[]; visible?: () => boolean };
const group = (heading: string | undefined, items: (SettingDefinition | SettingDefinitionPage)[], visible?: () => boolean): Group =>
  ({ type: "group", ...(heading ? { heading } : {}), items, ...(visible ? { visible } : {}) });
type Page = SettingDefinitionPage & { id?: string };
const onOff = (on: boolean) => on ? "On" : "Off";

class AgentManagerSettingsTab extends import_obsidian.PluginSettingTab {
  declare plugin: AgentManagerPlugin;
  constructor(app: App, plugin: AgentManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  override getSettingDefinitions(): SettingDefinitionItem[] {
    const core = this.plugin.terminal;
    const pages: Page[] = [
      { type: "page", name: "Sidebar", desc: "The buttons at the top of the sidebar, and its tab.", items: this.sidebarPage() },
      { type: "page", name: "Sessions", desc: "The wrap button, files sessions send, where session tabs go, and what's kept through a reload.", items: this.sessionsPage() },
      { type: "page", name: "Openings", desc: "What a new session is told first, for each kind of start.", items: this.openingsPage() },
      { type: "page", name: "Projects and tickets", desc: "Project overview notes, and tickets with their sessions listed in them.", displayValue: () => onOff(this.plugin.overviewsOn() || this.plugin.ticketsOn()), items: this.contextPage() },
      { type: "page", name: "Agent profiles", desc: "Who a session starts as, for walling off kinds of work from each other.", displayValue: () => this.agentsValue(), items: this.agentsPage() },
      { type: "page", name: "Scheduled tasks", desc: "Prompts Claude Code runs on a schedule with nobody watching.", displayValue: () => onOff(this.plugin.scheduledTasksOn()), items: this.scheduledPage() },
      ...(core ? [
        { type: "page", name: "Notifications", desc: "A \"needs you\" notification is for something that broke or won't continue until you look at it. An information notice is for what's happening: what you just did, a session moved, a run that went fine. A session's questions, permission prompts, errors, and finished turns are built and tested for Claude Code sessions; Codex and Antigravity sessions aren't tested yet.", items: notificationDefinitions(core, { refresh: () => this.refreshDomState(), more: (rows) => this.scheduledNotification(rows) }) } satisfies Page,
      ] : []),
      { type: "page", name: "CLIs", desc: "Claude Code, Codex, and Antigravity: which are offered, how each is started, and the environment they get.", items: this.cliPage() },
      ...(core ? [
        { type: "page", name: "Terminal", desc: "How terminals look, scroll, and open links.", items: [group(undefined, appearanceDefinitions(core)), group("Links", linkDefinitions(core))] } satisfies Page,
      ] : []),
      { type: "page", name: "Advanced & experimental", desc: "Set up this vault, and where Python is.", items: this.advancedPage() },
    ];
    return [group(undefined, this.frontPage()), { ...group(undefined, pages), search: pageSearch }];
  }
  async save(): Promise<void> {
    await this.plugin.savePluginData();
  }
  rerenderSidebars(): void {
    for (const view of this.plugin.browserViews()) {
      try { view.renderBrowser(); } catch { /* empty */ }
    }
  }
  frontPage(): SettingDefinition[] {
    return [
      row("Default backend (CLI)", "What a new session runs until you pick another in the sidebar, and what a ticket with no CLI set starts on. Starting from a note or a folder offers it first. Lists the CLIs that are enabled under CLIs.", (st) => st.addDropdown((drop) => {
        const enabled = this.plugin.getBrowserBackends();
        for (const key of enabled) drop.addOption(key, CLI_BACKENDS[key].label);
        const current = this.plugin.getCurrentBackend();
        drop.setValue(enabled.includes(current) ? current : enabled[0]);
        drop.onChange(async (value) => {
          this.plugin.pluginData.cliBackend = value;
          await this.save();
          this.rerenderSidebars();
        });
      }), { aliases: ["CLI", "Claude Code", "Codex", "Antigravity"] }),
      row("AGENTS.md folder", "Where your AGENTS.md lives, and where every session starts. Claude Code, Codex, and Antigravity all read it. A session started in a folder below the vault's root isn't given the rest of the vault; what it may read or change outside the folder is up to the CLI's own permissions. Empty is the vault's root. Applies to new sessions.", (st) => st.addText((text) => {
        text.setPlaceholder("Vault root").setValue(stringOf(this.plugin.pluginData.startFolder || ""));
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim().replace(/^\/+|\/+$/g, "");
          if (v && !(this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(v)) instanceof import_obsidian.TFolder)) {
            notice({ head: "No such folder", detail: `There's no “${v}” in this vault.` });
            text.setValue(stringOf(this.plugin.pluginData.startFolder || ""));
            return;
          }
          if (v) this.plugin.pluginData.startFolder = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData.startFolder;
          await this.save();
          this.plugin.invalidateSessionIndex();
          this.rerenderSidebars();
        })(); });
      }), { aliases: ["start folder", "working folder"] }),
      this.nameRow("transcriptsFolder"),
      row("Keep tool commands", "Each shell command a session runs, folded under its line in the transcript, cut at 40 lines. Anything shaped like a key, a token, or a password is masked, but a command can still hold something private, so leave this off if your transcripts are shared. Applies to turns written from now on.", (st) => st.addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.transcriptCommands === true)
        .onChange(async (value) => {
          if (value) this.plugin.pluginData.transcriptCommands = true; else delete this.plugin.pluginData.transcriptCommands;
          await this.save();
        })), { aliases: ["transcript", "commands", "Bash"] }),
      row("Added folders", "Folders outside the vault that every session can read and write, one per line, such as a code repository. A leading ~ is your home folder. A folder that isn't on this machine is skipped. Applies to new sessions.", (st) => st.addTextArea((text) => {
        text.setPlaceholder("~/Code/my-project").setValue(this.plugin.addedFolderSetting().join("\n"));
        text.inputEl.addEventListener("change", () => { void (async () => {
          this.plugin.pluginData.addedFolders = String(text.inputEl.value || "").split("\n").map((l) => l.trim()).filter(Boolean);
          await this.save();
        })(); });
      }), { aliases: ["add-dir", "repository"] }),
    ];
  }
  buttonToggle(name: string, desc: string, key: "newButton" | "dailyChatButton" | "customButton" | "newTicketButton" | "pinnedSection", visible?: () => boolean): SettingDefinition {
    return row(name, desc, (st) => st.addToggle((toggle) => toggle
      .setValue(this.plugin.pluginData[key] !== false)
      .onChange(async (value) => {
        if (value) delete this.plugin.pluginData[key]; else this.plugin.pluginData[key] = false;
        await this.save();
        this.rerenderSidebars();
        this.refreshDomState();
      })), visible ? { visible } : {});
  }
  sidebarPage(): SettingDefinition[] {
    const d = () => this.plugin.pluginData;
    const custom = () => d().customButton !== false;
    const plainDaily = () => { const c = this.plugin.switchChoices(); return !c.length || c.some((x) => x.id === ""); };
    return [
      this.buttonToggle("Show the new session button", "A row in the sidebar, under the daily chat button, that opens a card for naming and starting a session. Turned off, sessions still start from the command palette, a note's or folder's menu, and the daily chat button.", "newButton"),
      this.textRow("newButtonName", "New session button name", "What the row says, after its icon.", DEFAULT_NEW_BUTTON_NAME, () => this.rerenderSidebars(), () => d().newButton !== false),
      row("Agent profiles", "Each agent profile's page has its own daily chat button, Pinned, and custom button, used while it's picked. The settings here for those are for No agent profile.", () => {}, { visible: () => this.plugin.switchChoices().length > 0 }),
      this.buttonToggle("Show the daily chat button", "A button at the top of the sidebar that opens today's chat, resuming or starting it. With agent profiles, each profile's page has its own, and this is for No agent profile.", "dailyChatButton", plainDaily),
      row("Daily chat name", "The day's chat is found and named by this. {{date}} is today's date, as 2026-10-19. With agent profiles, each profile's page has its own, and this is for No agent profile.", (st) => st.addText((text) => {
        text.setPlaceholder(DEFAULT_DAILY_NAME).setValue(stringOf(d().dailyChatName || ""));
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (v && v !== DEFAULT_DAILY_NAME) d().dailyChatName = v; else delete d().dailyChatName;
          await this.save();
          this.rerenderSidebars();
        })(); });
      }), { visible: () => plainDaily() && d().dailyChatButton !== false }),
      this.buttonToggle("Show Pinned", "The Pinned section, where you keep sessions in an order of your own. Off, pinned sessions are listed in Recent, and sessions can't be pinned. With agent profiles, each profile's page has its own, and this is for No agent profile.", "pinnedSection", plainDaily),
      this.buttonToggle("Show the custom button", "A button at the right of the sidebar's header, left of the pop-out button, that opens a note, a base, or a link. Each agent profile can have a custom button of its own too, on its page. While tickets are on, it opens the tickets note unless you set it to something else; otherwise it shows once it has something to open.", "customButton"),
      this.textRow("customButtonIcon", "Custom button icon", "A Lucide icon's name, as on lucide.dev, such as ticket or layout-dashboard. Empty, or a name Obsidian doesn't have, is a ticket while it opens the tickets note, else a link.", stringOf(d().customButtonTarget ?? "").trim() ? "link" : "ticket", () => this.rerenderSidebars(), custom),
      this.textRow("customButtonName", "Button text", "What the button says beside its icon. Empty shows the icon alone.", "", () => this.rerenderSidebars(), custom),
      row("Custom button opens", "A note or base in this vault, or a web or Obsidian link. Empty is the tickets note while tickets are on.", (st) => st.addText((text) => {
        text.setPlaceholder(this.plugin.ticketsOn() ? this.plugin.ticketsNotePath() : "").setValue(stringOf(d().customButtonTarget || ""));
        new FileSuggest(this.app, text.inputEl, ["md", "base"]);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (!v) delete d().customButtonTarget;
          else d().customButtonTarget = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : (0, import_obsidian.normalizePath)(v);
          await this.save();
          this.rerenderSidebars();
        })(); });
      }), { visible: custom }),
      row("Show the pop-out button", "An arrow at the right of the sidebar's header that turns on pop-out mode, moving Agent Manager into a window of its own with every session tab (or, while it's on, brings that window forward), and one in that window's sidebar that docks it. With it off, the two commands for it still do both, and closing the window still docks it.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().windowButton !== false)
        .onChange(async (value) => {
          if (value) delete d().windowButton; else d().windowButton = false;
          await this.save();
          this.rerenderSidebars();
        })), { aliases: ["pop out", "pop-out", "own window", "separate window"] }),
      row("Show the name on the sidebar tab", "Show “Agent Manager” beside the sidebar tab's icon.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().showSidebarTitle === true)
        .onChange(async (value) => {
          d().showSidebarTitle = value;
          await this.save();
          this.plugin.applySidebarTitleClass();
        }))),
    ];
  }
  sessionsPage(): SettingDefinition[] {
    const d = () => this.plugin.pluginData;
    return [
      row("Wrap message", "Exactly what the wrap button types into the session. To run a skill instead, put its command here, such as /wrap for a skill named wrap. In Codex sessions the plugin rewrites /wrap as $wrap, the form Codex needs. Empty hides the button.", (st) => st
        .addTextArea((text) => {
          text.setValue(this.plugin.wrapMessage());
          text.inputEl.rows = 2;
          text.inputEl.addEventListener("change", () => { void (async () => {
            d().wrapMessage = text.inputEl.value.trim();
            await this.save();
          })(); });
        })
        .addExtraButton((btn) => btn
          .setIcon("rotate-ccw")
          .setTooltip("Restore the default")
          .onClick(async () => {
            delete d().wrapMessage;
            await this.save();
            this.update();
          }))),
      row("Save generated files", "A file a Claude Code session sends you (with its send-file tool) is copied into the vault and shown in the session's transcript note. By default it goes where Obsidian puts a new attachment for the note the session was started from, as set in Obsidian's own settings. Codex and Antigravity have no such tool; a file they make is written where you ask for it.", (st) => st.addDropdown((drop) => {
        drop.addOption("obsidian", "Where Obsidian puts attachments");
        drop.addOption("own", "In a folder set here");
        drop.addOption("off", "Don't save them");
        const v = d().sentFiles;
        drop.setValue(v === "own" || v === "off" ? v : "obsidian");
        drop.onChange(async (value) => {
          if (value === "obsidian") delete d().sentFiles; else d().sentFiles = value;
          await this.save();
          this.refreshDomState();
        });
      }), { aliases: ["attachments", "sent files"] }),
      row("Folder for sent files", "A folder in the vault. Start it with ./ to put it beside the note the session was started from.", (st) => st.addText((text) => {
        text.setPlaceholder("./Files").setValue(stringOf(d().sentFilesFolder || ""));
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim();
          if (v) d().sentFilesFolder = v; else delete d().sentFilesFolder;
          await this.save();
        })(); });
      }), { visible: () => d().sentFiles === "own" }),
      row("Keep sessions in their own split", "Session tabs open in a tab group of their own on the right, and notes never open there.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().dedicatedTerminalSplit !== false)
        .onChange(async (value) => {
          d().dedicatedTerminalSplit = value;
          await this.save();
        }))),
      row("Keep pane widths when resizing", "When a sidebar or the window changes size, only the pane next to the edge that moved changes width, and the panes beside it keep theirs. Dragging the line between two panes works as it always has. In pop-out mode, Agent Manager's sidebar keeps its width too.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().keepPaneWidths === true)
        .onChange(async (value) => {
          if (value) d().keepPaneWidths = true; else delete d().keepPaneWidths;
          await this.save();
          this.plugin.syncPaneWidths();
        }))),
      row("Keep unsent text through a reload", "Text typed into a session and not sent is saved with its tab, in this vault's workspace file, and put back in the prompt after Obsidian or the plugin reloads. Claude Code and Codex sessions only, for now: Antigravity's prompt doesn't work with it. Turned off, nothing is saved, and each tab drops what it saved (a tab not opened since Obsidian started, when it's next opened).", (st) => st.addToggle((toggle) => toggle
        .setValue(d().keepDrafts !== false)
        .onChange(async (value) => {
          if (value) delete d().keepDrafts; else d().keepDrafts = false;
          await this.save();
          this.app.workspace.requestSaveLayout();
          this.refreshDomState();
        })), { aliases: ["draft"] }),
      row("Copy unsent text that can't be put back", "When saved text can't go back in the prompt (you typed first, or the session asked a question or didn't start), copy it to the clipboard, replacing what's there. Turned off, it's dropped, and a notification says so.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().draftClipboard === true)
        .onChange(async (value) => {
          if (value) d().draftClipboard = true; else delete d().draftClipboard;
          await this.save();
        })), { visible: () => d().keepDrafts !== false }),
      row("Local server", "Lets Claude Code sessions report to Agent Manager as they work, through Claude's hooks. Turned on and off with the conversation view, below, and can be switched on by itself. With it on, you can type in the conversation view and answer approvals and Claude's questions there, replies can stream, and a session is told when another session is in the middle of a turn in the same code repo, so they can check with each other before building or committing (a line, only the first time). It's a small server on this computer only (127.0.0.1, a port the system picks), with a secret key that's new each time Obsidian starts; it never reaches the internet and costs nothing while idle. Off, the conversation view is for reading, and you type in the terminal. Takes effect for each session at its next start or resume.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().localServer === true)
        .onChange(async (value) => {
          if (value) d().localServer = true; else delete d().localServer;
          await this.save();
          this.refreshDomState();
        })), { aliases: ["server", "hooks", "approvals", "streaming", "other sessions"] }),
      row("Conversation view (experimental)", "Claude Code sessions open in a view of the conversation, as in the Claude app, with the terminal running underneath and the strip's switch to go between them. It's a view you work in: a message box, approvals and Claude's questions as cards, and a Stop button. Turning this on also turns on Local server, above, which the view needs for typing and approvals, and turning it off turns Local server off; with Local server off, the view is for reading and you type in the terminal. Codex and Antigravity sessions get it to read. Sessions already open get the switch at once; a Claude session can be typed in from the view, and opens in it, from its next start or resume.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().designedView === true)
        .onChange(async (value) => {
          if (!value) for (const v of this.plugin.sessionObjects()) { try { if (v._transcriptOpen) v.closeTranscript(true); } catch { /* empty */ } }
          if (value) d().designedView = true; else delete d().designedView;
          if (value) d().localServer = true; else delete d().localServer;
          await this.save();
          this.update();
          for (const v of this.plugin.sessionObjects()) { try { v.rebuildStrip(); } catch { /* empty */ } }
        })), { aliases: ["message box", "approvals", "designed view", "chat"] }),
      row("Sessions open in", "Which view a Claude session's tab shows when it starts, the terminal or the conversation view. Either way the strip's switch changes it.", (st) => st.addDropdown((drop) => drop
        .addOption("designed", "The conversation view")
        .addOption("terminal", "The terminal")
        .setValue(d().designedDefault === "terminal" ? "terminal" : "designed")
        .onChange(async (value) => {
          if (value === "terminal") d().designedDefault = "terminal"; else delete d().designedDefault;
          await this.save();
        })), { visible: () => d().designedView === true && d().localServer === true, aliases: ["default view"] }),
      row("Stream replies (experimental)", "Show Claude's replies in the conversation view as it writes them, a line at a time, instead of when each is finished. Through Claude's MessageDisplay hook, at each session's next start or resume.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().designedStream === true)
        .onChange(async (value) => {
          if (value) d().designedStream = true; else delete d().designedStream;
          await this.save();
        })), { visible: () => d().designedView === true && d().localServer === true, aliases: ["streaming"] }),
      row("Attachments folder", "Where files added with the view's + go, copied when you send, their paths put in your message. With agent profiles on, each profile can have its own, set on its page under Agent profiles; this one is for sessions with no profile, or a profile whose own is empty. Empty, the + says to set one.", (st) => st.addText((text) => {
        text.setPlaceholder("Inputs").setValue(typeof d().attachFolder === "string" ? d().attachFolder as string : "");
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = text.inputEl.value.trim();
          if (v) d().attachFolder = (0, import_obsidian.normalizePath)(v); else delete d().attachFolder;
          await this.save();
        })(); });
      }), { visible: () => d().designedView === true && d().localServer === true, aliases: ["inputs", "attach"] }),
      row("Load every session tab on restart", "Off: Obsidian restores session tabs unloaded, and each resumes when you open it. On: every restored session resumes at once, so they're running (and reachable through Claude's Remote Control) right after a restart, at the cost of a slower start.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().eagerLoadOnRestart === true)
        .onChange(async (value) => {
          d().eagerLoadOnRestart = value;
          await this.save();
        }))),
      row("Open notes in", "Where a note clicked in a session opens: in the tab that's showing (with notes split in two, the one you were last in; never a session or a terminal), or in a new tab at the end of the tabs. A note that's already open goes to its tab either way, and a pinned tab gets a new tab instead.", (st) => st.addDropdown((drop) => drop
        .addOption("last", "The tab that's showing")
        .addOption("new", "A new tab")
        .setValue(d().notesOpenIn === "new" ? "new" : "last")
        .onChange(async (value) => {
          if (value === "new") d().notesOpenIn = "new"; else delete d().notesOpenIn;
          await this.save();
        }))),
    ];
  }
  openingsPage(): SettingDefinition[] {
    const legend: SettingDefinition = { name: "Placeholders", desc: "{{path}} is the full path of the note or folder, {{vault}} the vault's, {{date}} today's. Empty sends nothing; a resumed session and a side chat are never sent anything." };
    return [legend, ...(Object.keys(DEFAULT_OPENING) as OpeningKey[]).map((key) => {
      const [label, desc] = OPENING_LABELS[key];
      return row(label, desc, (st) => {
        st.addTextArea((text) => {
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
              this.update();
            }));
        st.settingEl.addClass("agent-manager-env-setting");
      });
    })];
  }
  contextPage(): Group[] {
    const p = this.plugin;
    const tickets = () => p.ticketsOn();
    const ticketButton = () => tickets() && p.pluginData.newTicketButton !== false;
    return [
      group(undefined, [
        row("Use project overviews", "A folder with a project overview note is a project. A session started from a note or a folder is first told to read every project overview from the AGENTS.md folder down to it, broadest first, and the repo the nearest one names in its repo property. Tickets build on them, so turning tickets on turns these on too.", (st) => st.addToggle((toggle) => toggle
          .setValue(p.overviewsOn())
          .onChange(async (value) => {
            p.pluginData.useOverviews = value;
            await this.save();
            this.update();
          }))),
        this.textRow("overviewName", "Project overview file name", "The note in a folder that describes its project.", DEFAULT_OVERVIEW_NAME, undefined, () => p.overviewsOn()),
        this.pathRow("overviewTemplate", "Project overview template", "The note a new project overview is made from (the folder menu's Add a project overview). {{name}} is the folder's name. Empty is a short one built in.", "Built in", undefined, () => p.overviewsOn()),
      ]),
      group("Tickets", [
        row("Use tickets", "A note with type: ticket in its properties is a ticket: a session started from it is told it's a ticket, and its sessions are listed in it. Turning this on also turns on project overviews, since a ticket's session reads its project's overview, and creates a tickets base in the AGENTS.md folder and the ticket template, where they're missing.", (st) => st.addToggle((toggle) => toggle
          .setValue(p.ticketsOn())
          .onChange(async (value) => {
            p.pluginData.useTickets = value;
            if (value) p.pluginData.useOverviews = true;
            await this.save();
            if (value) await p.ensureTicketFiles();
            this.rerenderSidebars();
            this.update();
          }))),
        this.pathRow("ticketTemplate", "Ticket template", "The note a new ticket is made from. It's never counted as a ticket itself.", DEFAULT_TICKET_TEMPLATE, undefined, tickets),
        this.pathRow("ticketsNote", "Tickets note", "The note or base the Open tickets command opens, and the sidebar's custom button unless it's set to something else: such as a dashboard that embeds the tickets base. Empty is the tickets base in the AGENTS.md folder.", "Tickets.base", () => this.rerenderSidebars(), tickets),
        this.buttonToggle("Show the new ticket button", "A row in the sidebar, under new session, that opens a card for making a ticket: its name, its project, notes, and the CLI it starts on. While agent profiles are on, it offers the switched profile's projects.", "newTicketButton", tickets),
        this.textRow("newTicketButtonName", "New ticket button name", "What the row says, after its icon.", DEFAULT_NEW_TICKET_BUTTON_NAME, () => this.rerenderSidebars(), ticketButton),
        row("Show the launch button on the new ticket card", "A second button on the new ticket card that makes the ticket and starts its main session on the CLI picked, named for the ticket. The first only makes the ticket and opens it.", (st) => st.addToggle((toggle) => toggle
          .setValue(p.pluginData.ticketLaunchButton !== false)
          .onChange(async (value) => {
            if (value) delete p.pluginData.ticketLaunchButton; else p.pluginData.ticketLaunchButton = false;
            await this.save();
            this.rerenderSidebars();
          })), { visible: ticketButton }),
        this.textRow("ticketNotesHeading", "Where the card's notes go", "A heading in the ticket template for the new ticket card's notes to go under, written as it is in the template, such as ## Notes. Empty, or a heading the template doesn't have, puts them first, right under the properties.", "Under the properties", undefined, ticketButton),
      ]),
    ];
  }
  scheduledPage(): SettingDefinition[] {
    const on = () => this.plugin.scheduledTasksOn();
    const setSched = async (patch: Record<string, unknown>) => {
      const raw = this.plugin.pluginData.scheduler;
      this.plugin.pluginData.scheduler = { ...(raw && typeof raw === "object" ? raw : {}), ...patch };
      await this.save();
    };
    const number = (name: string, desc: string, get: () => number, put: (v: number) => Promise<void>) => row(name, desc, (st) => st.addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(get()));
      text.inputEl.addEventListener("change", () => { void put(Number(text.inputEl.value)); });
    }), { visible: on });
    return [
      row("Use scheduled tasks", "A note with type: scheduled task in its properties, in a folder of its own, is a prompt Claude Code runs on a schedule with nobody watching, as a full session in a tab: your own settings, less what the task turns off or refuses. Nothing runs until you approve it on this computer. The sidebar has a row that opens their page.", (st) => st.addToggle((toggle) => toggle
        .setValue(on())
        .onChange(async (value) => {
          this.plugin.pluginData.useScheduledTasks = value;
          await this.save();
          this.rerenderSidebars();
          this.update();
        }))),
      row("Run scheduled tasks on this computer", "Kept on this computer only, not in the vault. Runs happen only while Obsidian is open and the computer is awake, and each task runs only once you've approved what it can reach here. Turn this on in one computer only, or both would run every task.", (st) => st.addToggle((toggle) => toggle
        .setValue(this.plugin.schedulerOn())
        .onChange((value) => { this.plugin.setSchedulerOn(value); })), { visible: on, aliases: ["scheduler"] }),
      row("Scheduled tasks folder", "Where the new task card puts new tasks. With agent profiles off, every new task goes here. With them on, a new task goes in a Scheduled Tasks folder inside the folder of the agent you've switched to, and comes here only when that agent has no folder set. Empty means a Scheduled Tasks folder at the top of the vault. A task runs wherever it is; this only decides where new ones go.", (st) => st.addText((text) => {
        text.setPlaceholder(DEFAULT_SCHEDULED_FOLDER).setValue(stringOf(this.plugin.pluginData.scheduledFolder || ""));
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = String(text.inputEl.value || "").trim().replace(/^\/+|\/+$/g, "");
          if (v && !v.split("/").includes("..")) this.plugin.pluginData.scheduledFolder = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData.scheduledFolder;
          await this.save();
        })(); });
      }), { visible: on }),
      this.pathRow("taskTemplate", "Task template", "The note a new task is made from. It's never counted as a task itself.", DEFAULT_TASK_TEMPLATE, () => this.plugin.resetTaskIndex(), on),
      row("Never let a run read", "Folders and files no run may read, whatever its task allows, one per line. For something in the vault, write its path from the top of the vault with no slash in front: just Private for a folder there, or Work/Private for one inside another. For somewhere else on this computer, start with ~ for your home folder (~/Documents) or / for the full path. A run's file tools are refused these, and so is its shell while it's sandboxed (with the web off or a list of sites).", (st) => st.addTextArea((area) => {
        area.setPlaceholder("Private").setValue(this.plugin.neverReadSetting().join("\n"));
        area.inputEl.rows = 4;
        area.inputEl.addEventListener("change", () => { void (async () => {
          const lines = String(area.inputEl.value || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          if (lines.length) this.plugin.pluginData.neverRead = lines; else delete this.plugin.pluginData.neverRead;
          await this.save();
          this.rerenderSidebars();
        })(); });
      }), { visible: on, aliases: ["private", "deny"] }),
      row("Commit each run's result", "When the vault is a Git repository, each run's result, its run log, its memory, and a full session run's action log are committed, with Git's hooks off.", (st) => st.addToggle((toggle) => toggle
        .setValue(this.plugin.schedSettings().commitRuns)
        .onChange(async (value) => { await setSched({ commitRuns: value }); })), { visible: on, aliases: ["git"] }),
      number("Runs at once", "The most tasks that run at the same time. A task that's due waits for a free one.", () => this.plugin.schedSettings().runsAtOnce, (v) => setSched({ runsAtOnce: Math.max(1, Math.floor(v) || 3) })),
      number("Time limit per run", "In minutes. A run still going then is logged as stalled and left open, never ended.", () => this.plugin.schedSettings().timeLimitMin, (v) => setSched({ timeLimitMin: Math.max(1, Math.floor(v) || 30) })),
      number("Results in Latest Outputs", "How many of the newest results, across every task, Latest Outputs lists. Older ones stay in each task's own folder.", () => this.plugin.schedSettings().latestOutputs, (v) => setSched({ latestOutputs: Math.max(1, Math.floor(v) || 50) })),
    ];
  }
  scheduledNotification(rows: NotificationRows): SettingDefinition[] {
    const put = async (patch: Record<string, unknown>) => {
      const raw = this.plugin.pluginData.scheduler;
      this.plugin.pluginData.scheduler = { ...(raw && typeof raw === "object" ? raw : {}), ...patch };
      await this.save();
    };
    return rows("When a scheduled run goes fine", "Where a notification goes when a run the schedule started finishes cleanly. One that fails, waits, stalls, or is held is a \"needs you\" notification instead. Clicking it opens the task.", "Scheduled run notification length", {
      where: () => this.plugin.schedSettings().fineTo,
      seconds: () => this.plugin.schedSettings().fineSeconds,
      onWhere: (v) => put({ fineTo: v }),
      onSeconds: (v) => put({ fineSeconds: v }),
      visible: () => this.plugin.scheduledTasksOn(),
    });
  }
  agentsValue(): string {
    if (!this.plugin.agentsOn()) return "Off";
    const n = this.plugin.allAgents().length;
    return n === 1 ? "1 profile" : `${n} profiles`;
  }
  async saveAgents(list: AgentDef[]): Promise<void> {
    this.plugin.pluginData.agents = list;
    await this.save();
    this.rerenderSidebars();
    for (const session of this.plugin.sessionObjects()) session.refreshStripAgent();
    this.plugin.paintAgentTabs();
  }
  agentsPage(): Group[] {
    const p = this.plugin;
    const on = () => p.agentsOn();
    const all = p.allAgents();
    const add = row("Add an agent profile", undefined, (st) => st.addButton((b) => b.setButtonText("Add").setClass("agent-manager-button").onClick(() => {
      new AgentModal(this.app, (name) => agentNameProblem(name, p.allAgents().map((a) => a.name)), async (f) => {
        const home = parseHome(f.home);
        const list = p.allAgents();
        list.push({
          id: p.newSessionId(),
          name: f.name.trim(),
          instructions: f.instructions.trim() ? (0, import_obsidian.normalizePath)(f.instructions.trim()) : "",
          home: home ? (0, import_obsidian.normalizePath)(home) : home,
          dailyName: f.dailyName.trim(),
          dailyOn: true,
          dailyButton: "",
          pinnedOn: true,
          enabled: true,
          color: "",
          blackText: null,
          dashboardOn: false,
          dashboardTarget: "",
          dashboardName: "",
          dashboardIcon: "",
          attachFolder: "",
        });
        await this.saveAgents(list);
        this.update();
      }, DEFAULT_AGENT_DAILY_NAME).open();
    })));
    const profiles = group("Profiles", [...all.map((agent, index) => this.profilePage(agent, index)), add], on);
    return [
      group(undefined, [
        row("Use agent profiles", "Every session is an agent; a profile is who it starts as. Most vaults need none: one session can do any kind of work, and project overviews organize it by project. Profiles are for walling things off, such as work and personal, when each needs its own instructions and its own reference files, not one per role. Turned off, any added profiles are kept.", (st) => st.addToggle((toggle) => toggle
          .setValue(on())
          .onChange(async (value) => {
            p.pluginData.useAgents = value;
            await this.save();
            this.rerenderSidebars();
            for (const session of p.sessionObjects()) session.refreshStripAgent();
            p.paintAgentTabs();
            this.update();
          }))),
        row("Profile colors", "Each profile's color as a line above its session tabs, on its name in a session's strip, and in the sidebar's switch. Each starts with a color of its own, which you can change on its page.", (st) => st.addToggle((toggle) => toggle
          .setValue(p.colorsOn())
          .onChange(async (value) => {
            p.pluginData.agentColors = value;
            await this.save();
            p.refreshAgentColors();
            this.update();
          })), { visible: on }),
        row("No agent profile", "Lets a session have no agent profile: the default below can then be No agent profile, and while it is, the sidebar's switch offers it beside your profiles. Off, every session starts as a profile, the first one unless you pick another default.", (st) => st.addToggle((toggle) => toggle
          .setValue(p.noAgentOn())
          .onChange(async (value) => {
            if (value) p.pluginData.noAgentProfile = true; else delete p.pluginData.noAgentProfile;
            await this.save();
            this.rerenderSidebars();
            p.paintAgentTabs();
            this.update();
          })), { visible: on, aliases: ["no profile", "none"] }),
        row("Default agent profile", "The profile a session started from a note or folder outside every agent folder starts with, and where sessions with no agent profile are listed in the sidebar. With No agent profile on, it can be that, and the sidebar's switch then offers it too.", (st) => st.addDropdown((dd) => {
          if (p.noAgentOn()) dd.addOption("", "No agent profile");
          for (const a of p.agentList()) dd.addOption(a.id, a.name);
          dd.setValue(p.defaultAgent()?.id || "");
          dd.onChange(async (value) => {
            if (value) p.pluginData.defaultAgent = value; else delete p.pluginData.defaultAgent;
            await this.save();
            this.rerenderSidebars();
            p.paintAgentTabs();
          });
        }), { visible: () => on() && p.agentList().length > 0 }),
      ]),
      profiles,
    ];
  }
  profilePage(agent: AgentDef, index: number): Page {
    const p = this.plugin;
    const current = () => p.allAgents().find((a) => a.id === agent.id);
    const enabled = () => current()?.enabled === true;
    const live = () => current() ?? agent;
    const update = async (change: Partial<AgentDef>) => {
      const list = p.allAgents();
      const i = list.findIndex((a) => a.id === agent.id);
      if (i === -1) return;
      list[i] = { ...list[i], ...change };
      await this.saveAgents(list);
    };
    const field = { visible: enabled };
    const top: SettingDefinition[] = [
      row(`Use ${agent.name}`, "Off: its settings are kept. Its sessions are listed as if they had no agent profile.", (st) => st.addToggle((t) => t.setValue(live().enabled).onChange(async (value) => {
        await update({ enabled: value });
        this.update();
      }))),
    ];
    const identity: SettingDefinition[] = [
      row("Name", "Its transcripts go in a folder of this name in the transcripts folder.", (st) => st.addText((text) => {
        text.setValue(live().name);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const name = text.inputEl.value.trim();
          const old = live().name;
          if (name === old) return;
          const problem = agentNameProblem(name, p.allAgents().filter((a) => a.id !== agent.id).map((a) => a.name));
          if (problem) { notice(problem); text.setValue(old); return; }
          await update({ name });
          await p.renameAgentFiles(old, name);
          this.update();
        })(); });
      }), field),
      row("Instructions note", "The note that says who this agent profile is and how it works.", (st) => st.addText((text) => {
        text.setPlaceholder("Agents/Personal.md").setValue(live().instructions);
        new FileSuggest(this.app, text.inputEl, ["md"]);
        text.inputEl.addEventListener("change", () => { void update({ instructions: text.inputEl.value.trim() ? (0, import_obsidian.normalizePath)(text.inputEl.value.trim()) : "" }); });
      }), field),
      row("Agent folder", "A session started from a note or folder in here starts with this agent profile. Empty for none; / for the whole vault.", (st) => st.addText((text) => {
        const home = live().home;
        text.setPlaceholder("None").setValue(home === null ? "" : home === "" ? "/" : home);
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => {
          const home = parseHome(text.inputEl.value);
          void update({ home: home ? (0, import_obsidian.normalizePath)(home) : home });
        });
      }), { ...field, aliases: ["home folder"] }),
      row("Attachments folder", "Where files added with the conversation view's + go, for this profile's sessions. Empty for the general one (Sessions page).", (st) => st.addText((text) => {
        text.setPlaceholder("Inputs").setValue(live().attachFolder);
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addEventListener("change", () => { void update({ attachFolder: text.inputEl.value.trim() ? (0, import_obsidian.normalizePath)(text.inputEl.value.trim()) : "" }); });
      }), { visible: () => enabled() && p.pluginData.designedView === true && p.pluginData.localServer === true, aliases: ["inputs", "attach"] }),
    ];
    const sidebar: SettingDefinition[] = [
      row("Daily chat", "A button at the top of the sidebar, while this profile is picked, that opens its chat for today, resuming or starting it.", (st) => st.addToggle((t) => t.setValue(live().dailyOn).onChange(async (value) => {
        await update({ dailyOn: value });
        this.update();
      })), { ...field, aliases: ["daily chat button"] }),
      row("Daily chat button text", "What the button says above today's date.", (st) => st.addText((text) => {
        text.setPlaceholder(`${live().name} Daily Chat`).setValue(live().dailyButton);
        text.inputEl.addEventListener("change", () => { void update({ dailyButton: text.inputEl.value.trim() }); });
      }), { visible: () => enabled() && live().dailyOn }),
      row("Daily chat name", "Its chat for the day is found and named by this. {{profile}} is its name, {{date}} today's date.", (st) => st.addText((text) => {
        text.setPlaceholder(DEFAULT_AGENT_DAILY_NAME).setValue(live().dailyName);
        text.inputEl.addEventListener("change", () => { void update({ dailyName: text.inputEl.value.trim() }); });
      }), { visible: () => enabled() && live().dailyOn }),
      row("Pinned", "The Pinned section, while this profile is picked. Off, its pinned sessions are listed in Recent, and sessions can't be pinned.", (st) => st.addToggle((t) => t.setValue(live().pinnedOn).onChange(async (value) => {
        await update({ pinnedOn: value });
      }))),
      row("Custom button", "A button of this profile's own under the sidebar's switch while it's picked, such as its dashboard.", (st) => st.addToggle((t) => t.setValue(live().dashboardOn).onChange(async (value) => {
        await update({ dashboardOn: value });
        this.update();
      })), { ...field, aliases: ["dashboard"] }),
      row("Custom button opens", "A note or base in this vault, or a web or Obsidian link. Empty for no button.", (st) => st.addText((text) => {
        text.setValue(live().dashboardTarget);
        new FileSuggest(this.app, text.inputEl, ["md", "base"]);
        text.inputEl.addEventListener("change", () => { void (async () => {
          const v = text.inputEl.value.trim();
          await update({ dashboardTarget: !v || /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : (0, import_obsidian.normalizePath)(v) });
        })(); });
      }), { visible: () => enabled() && live().dashboardOn }),
      row("Custom button text", "What it says beside its icon. Empty says the name of what it opens.", (st) => st.addText((text) => {
        text.setPlaceholder(live().dashboardTarget.replace(/^.*\//, "").replace(/\.(md|base)$/, "")).setValue(live().dashboardName);
        text.inputEl.addEventListener("change", () => { void update({ dashboardName: text.inputEl.value.trim() }); });
      }), { visible: () => enabled() && live().dashboardOn }),
      row("Custom button icon", "A Lucide icon's name, as on lucide.dev, such as house or briefcase. Empty, or a name Obsidian doesn't have, is a dashboard icon.", (st) => st.addText((text) => {
        text.setPlaceholder(DEFAULT_DASHBOARD_ICON).setValue(live().dashboardIcon);
        text.inputEl.addEventListener("change", () => { void update({ dashboardIcon: text.inputEl.value.trim() }); });
      }), { visible: () => enabled() && live().dashboardOn }),
    ];
    const colorRows: SettingDefinition[] = [
      row("Color", undefined, (color) => {
        const shown = profileColor(live(), index);
        const desc = (custom: boolean) => custom ? "Your pick. The button puts back its default." : "Its default.";
        color.setDesc(desc(!!live().color));
        const pick = (0, import_obsidian.debounce)((value: string) => { void (async () => {
          await update({ color: readColor(value) });
          p.refreshAgentColors();
          color.setDesc(desc(true));
        })(); }, 250, true);
        color.addColorPicker((picker) => {
          picker.setValue(shown.color);
          picker.onChange((value) => pick(value));
        });
        color.addDropdown((d) => d
          .addOption("white", "White text")
          .addOption("black", "Black text")
          .setValue(shown.blackText ? "black" : "white")
          .onChange(async (v) => {
            await update({ blackText: v === "black" });
            p.refreshAgentColors();
          }));
        color.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("Default color").onClick(async () => {
          pick.cancel();
          await update({ color: "", blackText: null });
          p.refreshAgentColors();
          this.update();
        }));
      }, { visible: () => enabled() && p.colorsOn() }),
    ];
    const manage: SettingDefinition[] = [
      row("Move up", "Profiles are listed in this order in the sidebar's switch.", (st) => st.addButton((b) => b.setButtonText("Move up").onClick(async () => {
        const list = p.allAgents();
        const i = list.findIndex((a) => a.id === agent.id);
        if (i < 1) return;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        await this.saveAgents(list);
        this.update();
      })), { visible: () => p.allAgents().findIndex((a) => a.id === agent.id) > 0 }),
      row("Remove this agent profile", "Its sessions are listed as if they had no agent profile.", (st) => st.addButton((b) => b.setButtonText("Remove").setDestructive().onClick(async () => {
        await this.saveAgents(p.allAgents().filter((a) => a.id !== agent.id));
        if (p.pluginData.defaultAgent === agent.id) delete p.pluginData.defaultAgent;
        if (p.pluginData.currentAgent === agent.id) delete p.pluginData.currentAgent;
        await this.save();
        this.rerenderSidebars();
        this.update();
        (this.app as unknown as { setting?: { closePage?: () => void } }).setting?.closePage?.();
      }))),
    ];
    return { type: "page", id: agent.id, name: agent.name, displayValue: () => current()?.enabled === false ? "Off" : "", visible: () => p.agentsOn(), items: [
      group(undefined, top),
      group("Profile", identity, enabled),
      group("Sidebar", sidebar, enabled),
      group("Color", colorRows, () => enabled() && p.colorsOn()),
      group(undefined, manage),
    ] };
  }
  cliPage(): Group[] {
    const core = this.plugin.terminal;
    const groups: Group[] = REAL_BACKENDS.map((key) => {
      const backend = CLI_BACKENDS[key];
      const enabled = () => this.storedBackends().includes(key);
      const items: SettingDefinition[] = [
        row(`Enable ${backend.label}`, "While it's enabled, it's offered for new sessions in the sidebar and the file menu.", (st) => {
          const status = this.plugin.setupStatus();
          st.setDesc(createFragment((f) => {
            if (!status) f.appendText("Checking whether it's installed…");
            else if (status.installed[key]) f.appendText("Installed. While it's enabled, it's offered for new sessions in the sidebar and the file menu.");
            else {
              f.appendText("Not found. To install it, run this in Terminal, then sign in to it there once:");
              f.createEl("code", { cls: "agent-manager-setup-cmd", text: backend.install });
            }
          }));
          st.addToggle((toggle) => toggle
            .setValue(enabled())
            .onChange(async (value) => {
              let list = this.storedBackends();
              list = value ? REAL_BACKENDS.filter((k) => k === key || list.includes(k)) : list.filter((k) => k !== key);
              if (!list.length) {
                notice("At least one CLI has to be enabled");
                toggle.setValue(true);
                return;
              }
              this.plugin.pluginData.browserBackends = list;
              await this.save();
              this.rerenderSidebars();
              this.refreshDomState();
            }));
          if (status && !status.installed[key]) {
            st.addExtraButton((btn) => btn
              .setIcon("rotate-cw")
              .setTooltip("Check again")
              .onClick(async () => {
                await this.plugin.checkSetup(true);
                this.update();
              }));
          }
        }, { aliases: [backend.label, "install"] }),
      ];
      const agent = AGENTS.find((a) => a.id === key);
      if (core && agent) items.push(...agentDefinitions(core, agent, { visible: enabled }));
      if (key === "codex") items.push(row("Run on Codex's background server", "Off: every Codex session, new or resumed, runs on its own. On: Codex sessions run on Codex's background server. Applies to sessions started or resumed afterwards. A conversation last opened one way may refuse the other, saying it's open in another app, until Codex's server lets it go.", (st) => st.addToggle((toggle) => toggle
        .setValue(this.plugin.pluginData.codexServer === true)
        .onChange(async (value) => {
          this.plugin.pluginData.codexServer = value;
          await this.save();
        })), { visible: enabled, aliases: ["app server"] }));
      if (key === "claude") items.push(...this.claudeMods(enabled));
      return group(backend.label, items);
    });
    if (core) groups.push(group("Agent environment", agentVariableDefinitions(core)));
    return groups;
  }
  claudeMods(visible: () => boolean): SettingDefinition[] {
    const d = () => this.plugin.pluginData;
    return [
      row("Show pictures Claude sends or reads", "When Claude sends you a picture (with its send-file tool), or looks at one (a PNG it reads, such as a screenshot it took), it's drawn right in the session, framed, with buttons to open it, save it to your downloads folder, or copy its path. It works through a small Claude Code mod that comes with Agent Manager and is loaded only into sessions Agent Manager starts; nothing is installed in Claude Code itself. It also needs the terminal's picture setting to be on. Applies to sessions started or resumed afterwards.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().claudePictures !== false)
        .onChange(async (value) => {
          d().claudePictures = value;
          await this.save();
        })), { visible, aliases: ["images", "mod"] }),
      row("Fold tool output", "Adds /quiet to Claude sessions, and a Quiet button to the strip above them: it folds each tool's output (a file edit's diff, a command's output, a file read) into one line, and back again, for the whole session at once. Only the tools that produce output fold (file edits, commands, file reads, web fetches and searches, MCP tools); what Claude writes to you stays: its text, its questions, plans, task lists, links, and subagents' reports, and any errors. The transcript is untouched, and Ctrl+O still shows everything in full. Claude Code remembers whether it's on between sessions. It needs Claude Code's fullscreen rendering (/tui fullscreen) to fold output already shown. It works through a second small Claude Code mod that comes with Agent Manager, loaded only into sessions Agent Manager starts. Applies to sessions started or resumed afterwards.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().claudeQuietTools !== false)
        .onChange(async (value) => {
          d().claudeQuietTools = value;
          await this.save();
        })), { visible, aliases: ["quiet", "mod"] }),
      row("Show Remote Control on the strip", "A dot on a Claude session's strip: green while you can reach the session from claude.ai or the Claude app, grey while you can't, and hollow until Claude says. Claude reports it after each turn, so a session that disconnects while idle shows it at its next turn. Clicking a grey dot connects the session (it types /remote-control). Claude's own Remote Control setting decides which sessions connect; this only shows it.", (st) => st.addToggle((toggle) => toggle
        .setValue(d().remoteControlDot !== false)
        .onChange(async (value) => {
          d().remoteControlDot = value;
          await this.save();
          for (const s of this.plugin.sessionObjects()) s.rebuildStrip();
        })), { visible }),
    ];
  }
  storedBackends(): BackendKey[] {
    const stored = this.plugin.pluginData.browserBackends;
    return (isArray(stored) && stored.length ? stored : REAL_BACKENDS).filter((k) => isBackendKey(k));
  }
  advancedPage(): SettingDefinition[] {
    return [
      row("Set up this vault", "Starts a session that helps you set this vault up for agents: an AGENTS.md, where files go, and more if you'd like. You choose whether it asks before each change or sets things up itself and reports back; either way, it asks before changing anything already in the vault. You can close it and resume it later. An AI does the work, so results vary with the CLI and model.", (st) => {
        st.setName(createFragment((f) => {
          f.appendText("Set up this vault");
          f.createSpan({ cls: "agent-manager-badge", text: "Experimental" });
        }));
        st.addButton((b) => b.setButtonText("Set up").setClass("agent-manager-button").onClick(() => { void this.plugin.openVaultSetup(); }));
      }),
      ...(this.plugin.terminal ? pythonDefinitions(this.plugin.terminal) : []),
    ];
  }
  nameRow(key: NameKey): SettingDefinition {
    const [label, desc] = NAME_LABELS[key];
    return row(label, desc, (st) => st.addText((text) => {
      text.setPlaceholder(DEFAULT_NAMES[key]).setValue(stringOf(this.plugin.pluginData.names?.[key] || ""));
      new FolderSuggest(this.app, text.inputEl);
      text.inputEl.addEventListener("change", () => { void (async () => {
        const d = this.plugin.pluginData;
        d.names = d.names || {};
        const v = String(text.inputEl.value || "").trim();
        if (v && v !== DEFAULT_NAMES[key]) d.names[key] = v; else delete d.names[key];
        await this.save();
      })(); });
    }));
  }
  textRow(key: "overviewName" | "newButtonName" | "newTicketButtonName" | "ticketNotesHeading" | "customButtonName" | "customButtonIcon", name: string, desc: string, placeholder: string, after?: () => void, visible?: () => boolean): SettingDefinition {
    return row(name, desc, (st: Setting) => st.addText((text) => {
      text.setPlaceholder(placeholder).setValue(stringOf(this.plugin.pluginData[key] || ""));
      text.inputEl.addEventListener("change", () => { void (async () => {
        const v = String(text.inputEl.value || "").trim();
        if (v && v !== placeholder) this.plugin.pluginData[key] = v; else delete this.plugin.pluginData[key];
        await this.save();
        after?.();
      })(); });
    }), visible ? { visible } : {});
  }
  pathRow(key: "ticketsNote" | "overviewTemplate" | "ticketTemplate" | "taskTemplate", name: string, desc: string, placeholder: string, after?: () => void, visible?: () => boolean): SettingDefinition {
    return row(name, desc, (st) => st.addText((text) => {
      text.setPlaceholder(placeholder).setValue(stringOf(this.plugin.pluginData[key] || ""));
      new FileSuggest(this.app, text.inputEl, key === "ticketsNote" ? ["md", "base"] : ["md"]);
      text.inputEl.addEventListener("change", () => { void (async () => {
        const v = String(text.inputEl.value || "").trim();
        if (v) this.plugin.pluginData[key] = (0, import_obsidian.normalizePath)(v); else delete this.plugin.pluginData[key];
        await this.save();
        after?.();
      })(); });
    }), visible ? { visible } : {});
  }
}
export { AgentManagerSettingsTab };
