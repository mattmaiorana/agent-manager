
import type { Setting, SettingDefinition, SettingDefinitionItem } from "obsidian";
import { AGENTS, type AgentProfile } from "./agents";
import { DEFAULT_STRIPPED_VARIABLES } from "./finder";
import type { VaultTerminal } from "./core";

const COMMON_TERMINAL_FONTS = [
  "SF Mono", "Menlo", "Monaco", "Courier New",
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Hack",
  "IBM Plex Mono", "Iosevka", "Berkeley Mono", "MesloLGS NF", "Victor Mono",
];

function installedFonts(names: string[]): string[] {
  const ctx = createEl("canvas").getContext("2d");
  if (!ctx) return names;
  const sample = "mmmmmmmmmmlli10OoWw@#";
  const width = (font: string) => { ctx.font = `32px ${font}`; return ctx.measureText(sample).width; };
  const bases = ["monospace", "serif"].map((b) => [b, width(b)] as const);
  return names.filter((n) => bases.some(([b, w]) => width(`"${n}", ${b}`) !== w));
}

export interface AgentSettings {
  command: string;
  location: string;
}

export interface TerminalSettings {
  shell: string;
  agents: Record<string, AgentSettings>;
  agentVariables: string;
  strippedVariables: string;
  pythonLocation: string;
  fontSize: number;
  fontFamily: string;
  letterSpacing: number;
  lineHeight: number;
  scrollback: number;
  needsYouTo: NotifyWhere;
  needsYouSeconds: number;
  infoNotices: boolean;
  infoSeconds: number;
  finishedTo: NotifyWhere;
  finishedSeconds: number;
  hideLooking: boolean;
  keepRecent: boolean;
  statusIcons: boolean;
  dockBadge: boolean;
  optionKey: "characters" | "meta" | "right";
  bellSound: boolean;
  shellAfterExit: boolean;
  shellIntegration: boolean;
  scrollSpeed: number;
  linkClick: "cmd" | "click";
  markLinks: boolean;
  programClipboard: boolean;
  showPictures: boolean;
  keepPictures: boolean;
  ctrlCInterrupts: boolean;
  cursor: "line" | "block" | "underline";
  cursorBlink: boolean;
}

export { DEFAULT_STRIPPED_VARIABLES };

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shell: "",
  agents: {},
  agentVariables: "",
  strippedVariables: DEFAULT_STRIPPED_VARIABLES,
  pythonLocation: "",
  fontSize: 13,
  fontFamily: "",
  letterSpacing: 0,
  lineHeight: 1,
  scrollback: 10000,
  needsYouTo: "obsidian",
  needsYouSeconds: 10,
  infoNotices: true,
  infoSeconds: 5,
  finishedTo: "none",
  finishedSeconds: 5,
  hideLooking: false,
  keepRecent: true,
  statusIcons: true,
  dockBadge: false,
  bellSound: false,
  optionKey: "characters",
  shellIntegration: false,
  shellAfterExit: false,
  scrollSpeed: 1,
  linkClick: "click",
  markLinks: true,
  programClipboard: true,
  showPictures: true,
  keepPictures: true,
  ctrlCInterrupts: false,
  cursor: "line",
  cursorBlink: true,
};

export interface DefinitionOptions {
  refresh?: () => void;
}

type Section = (core: VaultTerminal, opts?: DefinitionOptions) => SettingDefinition[];
const saver = (core: VaultTerminal) => () => core.saveSettings();

export function row(name: string, desc: string | undefined, draw: (setting: Setting) => unknown, more: { visible?: () => boolean; aliases?: string[] } = {}): SettingDefinition {
  return { name, ...(desc ? { desc } : {}), ...more, render: (setting) => { draw(setting); } };
}

export const shellDefinitions: Section = (core) => {
  const save = saver(core);
  return [
    row("Shell", "The program a new terminal runs. Leave empty for your login shell.", (st) => st.addText((t) =>
      t.setPlaceholder(core.defaultShell()).setValue(core.settings.shell).onChange(async (v) => {
        core.settings.shell = v.trim();
        await save();
      }))),
    row("Shell integration for zsh", "zsh tells the terminal its current folder and where each prompt starts, for Cmd+Up and Cmd+Down between prompts, Cmd+click on paths relative to where you are, and opening a terminal in the same folder. Your startup files are read as usual and never changed. Applies to new terminals.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.shellIntegration).onChange(async (v) => {
        core.settings.shellIntegration = v;
        await save();
      }))),
    row("A shell when an agent ends", "When Claude, Codex or Antigravity exits, its tab becomes a shell in the folder it was working in, with what it printed still above. Off: the tab waits, and Enter starts the agent again or S starts a shell.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.shellAfterExit).onChange(async (v) => {
        core.settings.shellAfterExit = v;
        await save();
      }))),
  ];
};

export const agentVariableDefinitions: Section = (core) => {
  const save = saver(core);
  return [
    row("Environment variables for agents", "One NAME=value per line, given to Claude, Codex and Antigravity on top of what your login shell sets. Applies to new sessions. Saved in this plugin's settings file in the vault, so keep secrets in your shell's startup files instead, which the terminal reads but never saves.", (st) => st.addTextArea((t) => {
      t.setPlaceholder("ANTHROPIC_LOG=debug").setValue(core.settings.agentVariables).onChange(async (v) => {
        core.settings.agentVariables = v;
        await save();
      });
      t.inputEl.rows = 4;
      t.inputEl.addClass("vault-terminal-variables");
    }), { aliases: ["env", "environment"] }),
    row("Variables agents never get", "One name per line, taken out of every agent's environment after the variables above are added, whether your login shell or this setting set them. By default the API keys and provider switches, so a key in your startup files never moves an agent onto API billing or another provider. Applies to new sessions.", (st) => st.addTextArea((t) => {
      t.setValue(core.settings.strippedVariables).onChange(async (v) => {
        core.settings.strippedVariables = v;
        await save();
      });
      t.inputEl.rows = 5;
      t.inputEl.addClass("vault-terminal-variables");
    }), { aliases: ["API key"] }),
  ];
};

export function agentDefinitions(core: VaultTerminal, agent: AgentProfile, more: { visible?: () => boolean } = {}): SettingDefinition[] {
  const save = saver(core);
  const mine = () => (core.settings.agents[agent.id] ??= { command: "", location: "" });
  const program = agent.command.split(" ")[0];
  return [
    row("Command", `What the ${agent.name} terminal runs, with any arguments. Quote words that contain spaces.`, (st) => st.addText((t) =>
      t.setPlaceholder(agent.command).setValue(core.settings.agents[agent.id]?.command ?? "").onChange(async (v) => {
        mine().command = v.trim();
        await save();
      })), more),
    row(`Location of ${program}`, `The full path to ${program}, if it isn't found automatically.`, (st) => st.addText((t) =>
      t.setPlaceholder(`~/.local/bin/${program}`).setValue(core.settings.agents[agent.id]?.location ?? "").onChange(async (v) => {
        mine().location = v.trim();
        await save();
      })), more),
  ];
}

export type NotifyWhere = "desktop" | "obsidian" | "both" | "none";

export const toDesktop = (where: NotifyWhere): boolean => where === "desktop" || where === "both";

export const toObsidian = (where: NotifyWhere): boolean => where === "obsidian" || where === "both";

const NOTIFY_LENGTHS: [string, string][] = [["5", "5 seconds"], ["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["0", "Until clicked"]];

const lengthRow = (name: string, desc: string, seconds: () => number, onChange: (v: number) => Promise<void>, visible: () => boolean): SettingDefinition =>
  row(name, `${desc} Until clicked: it stays until you click it or its X.`, (st) => st.addDropdown((d) => {
    for (const [value, label] of NOTIFY_LENGTHS) d.addOption(value, label);
    return d.setValue(String(seconds())).onChange(async (v) => {
      await onChange(Number(v));
    });
  }), { visible });

export type NotificationRows = (
  name: string,
  desc: string,
  lengthName: string,
  o: { where: () => NotifyWhere; seconds: () => number; onWhere: (v: NotifyWhere) => Promise<void>; onSeconds: (v: number) => Promise<void>; visible?: () => boolean },
) => SettingDefinition[];

const notificationRows = (refresh: () => void): NotificationRows => (name, desc, lengthName, o) => [
  row(name, desc, (st) => st.addDropdown((d) => {
    for (const [value, label] of [["desktop", "Desktop"], ["obsidian", "Obsidian"], ["both", "Both"], ["none", "None"]]) d.addOption(value, label);
    return d.setValue(o.where()).onChange(async (v) => {
      await o.onWhere(v as NotifyWhere);
      refresh();
    });
  }), o.visible ? { visible: o.visible } : {}),
  lengthRow(lengthName, "How long one shows in Obsidian.", o.seconds, o.onSeconds, () => (o.visible?.() ?? true) && toObsidian(o.where())),
];

export function notificationDefinitions(core: VaultTerminal, opts: DefinitionOptions & { more?: (rows: NotificationRows) => SettingDefinition[] } = {}): SettingDefinition[] {
  const save = saver(core);
  const refresh = opts.refresh ?? (() => {});
  const rows = notificationRows(refresh);
  const kind = (name: string, desc: string, lengthName: string, key: "needsYouTo" | "finishedTo", lengthKey: "needsYouSeconds" | "finishedSeconds") =>
    rows(name, desc, lengthName, {
      where: () => core.settings[key],
      seconds: () => core.settings[lengthKey],
      onWhere: async (v) => {
        core.settings[key] = v;
        await save();
      },
      onSeconds: async (v) => {
        core.settings[lengthKey] = v;
        await save();
      },
    });
  const hideName = "Hide notifications from the session I'm looking at";
  return [
    ...kind(
      "Where \"needs you\" notifications go",
      "Something broke, or won't continue until you look at it: a session asks a question, asks for permission, or stops with an error; something you asked for wasn't sent; a scheduled run fails, waits, or stalls. Desktop: a macOS notification, whose sound and how long it stays are set for Obsidian in macOS's notification settings; choose Desktop or Both to hear about it while you're in another app. Obsidian: in the corner of the session you're looking at, at the top right otherwise. Clicking one takes you to the session or task it's about. None: nothing tells you.",
      "\"Needs you\" notification length",
      "needsYouTo",
      "needsYouSeconds",
    ),
    row("Information notices in Obsidian", "What's happening, where nothing broke and nothing waits on you: a copy or a rename confirmed, a session moved to a new ID, a warning about something you just did. Each has an X that only closes it. Off: none of these appear, so you won't see warnings or errors from what you click either.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.infoNotices).onChange(async (v) => {
        core.settings.infoNotices = v;
        await save();
        refresh();
      }))),
    lengthRow("Information notice length", "How long each information notice stays, all alike.", () => core.settings.infoSeconds, async (v) => {
      core.settings.infoSeconds = v;
      await save();
    }, () => core.settings.infoNotices),
    ...kind("When a session finishes its turn", "Where a notification goes when a session finishes its turn and waits for you, or a program in a plain terminal says it's done. The tab shows whether a session is working or done either way. Clicking it takes you to the session.", "Finished turn notification length", "finishedTo", "finishedSeconds"),
    ...(opts.more?.(rows) ?? []),
    row(hideName, "When the session in front of you asks a question, asks for permission, stops with an error, or finishes its turn, it doesn't notify you, since you can see it. Other sessions still notify you, and so does anything you asked for that wasn't sent.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.hideLooking).onChange(async (v) => {
        core.settings.hideLooking = v;
        await save();
      }))),
    row("Keep recent notices", "Keeps the last 50 notices, of every kind that showed, so you can look back at one you missed: \"Show recent notices\", a command and an item in the sidebar icon's right-click menu. Copies are left out. The list lasts through a reload, but a notice from before one can't be clicked. Off: none are kept, and turning it off clears the list.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.keepRecent).onChange(async (v) => {
        core.settings.keepRecent = v;
        if (!v) core.clearRecent();
        await save();
      })), { aliases: ["history", "recent"] }),
    row("Waiting count on the Dock icon", "Obsidian's Dock icon shows how many agent sessions are waiting for you, in this vault and others with it on. Off: this vault's sessions aren't counted.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.dockBadge).onChange(async (v) => {
        core.settings.dockBadge = v;
        await save();
        core.updateBadge();
      })), { aliases: ["badge"] }),
    row("Status icons on tabs", "A terminal's tab icon shows what its program is doing: working, waiting for you, finished, or a bell. Off: the tab keeps the terminal's or agent's own icon.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.statusIcons).onChange(async (v) => {
        core.settings.statusIcons = v;
        await save();
        core.refreshLook();
      }))),
    row("Sound on bell", "Play a short tone when a program rings the terminal bell, a terminal's own simple way of asking for attention. Claude Code sessions don't use it, since the plugin has Claude notify you as above. The terminal's tab is marked with a bell either way, until you look at it.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.bellSound).onChange(async (v) => {
        core.settings.bellSound = v;
        await save();
      }))),
  ];
}

export const appearanceDefinitions: Section = (core) => {
  const save = saver(core);
  const s = () => core.settings;
  return [
    row("Font size", undefined, (st) => st.addSlider((sl) =>
      sl.setLimits(8, 28, 1).setValue(s().fontSize).onChange(async (v) => {
        s().fontSize = v;
        await save();
        core.refreshLook();
      }))),
    row("Font", "A font family, as CSS names it. It has to be installed on this computer; a name that isn't falls back to Obsidian's monospace font. The box suggests the common terminal fonts you have. Leave empty for Obsidian's monospace font.", (st) => st.addText((t) => {
      t.setPlaceholder("Obsidian's monospace font").setValue(s().fontFamily).onChange(async (v) => {
        s().fontFamily = v;
        await save();
        core.refreshLook();
      });
      const have = installedFonts(COMMON_TERMINAL_FONTS);
      const list = st.controlEl.createEl("datalist", { attr: { id: "vault-terminal-fonts" } });
      for (const f of have) list.createEl("option", { attr: { value: f } });
      t.inputEl.setAttr("list", "vault-terminal-fonts");
      t.inputEl.title = `Common terminal fonts: ${COMMON_TERMINAL_FONTS.join(", ")}. Installed here: ${have.join(", ") || "none of them"}.`;
    }), { aliases: ["typeface", "font family"] }),
    row("Letter spacing", "Extra space between characters, in pixels.", (st) => st.addSlider((sl) =>
      sl.setLimits(-2, 5, 0.5).setValue(s().letterSpacing).onChange(async (v) => {
        s().letterSpacing = v;
        await save();
        core.refreshLook();
      }))),
    row("Line height", "The height of each row, as a multiple of the font's.", (st) => st.addSlider((sl) =>
      sl.setLimits(1, 2, 0.05).setValue(s().lineHeight).onChange(async (v) => {
        s().lineHeight = v;
        await save();
        core.refreshLook();
      }))),
    row("Scrollback lines", "How many lines each terminal keeps above its screen. Ten full terminals at 10,000 lines took about 230 MB of Obsidian's memory, and more of the system's; fewer lines use less. Applies to open terminals at once.", (st) => st.addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(s().scrollback)).onChange(async (v) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 0 || n > 1000000) return;
        s().scrollback = n;
        await save();
        core.refreshLook();
      });
    })),
    row("Scroll speed", "Lines scrolled per line of wheel or trackpad travel, from 0.25 to 4, the same in a shell's scrollback and in a full-screen program like Claude. At 1, about three lines a mouse notch. Applies to open terminals at once. This isn't Claude's own scroll speed: Agent Manager sets that to 0.25, so Claude moves one line per step instead of jumping three when you scroll slowly, and this setting still decides how far it goes. If you've set Claude's scroll speed or acceleration yourself, yours is used.", (st) => st.addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "0.25";
      t.inputEl.max = "4";
      t.inputEl.step = "0.25";
      t.setValue(String(s().scrollSpeed)).onChange(async (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0.25 || n > 4) return;
        s().scrollSpeed = n;
        await save();
      });
    }), { aliases: ["wheel", "trackpad"] }),
    row("Option key", "What Option does with another key. Characters: it types what your keyboard layout gives (é, @, €). Meta: it sends Escape before the key, for programs that use Meta (Option+Left and Option+Right still move by word either way). Right Option as Meta: the right one sends Meta and the left one still types characters.", (st) => st.addDropdown((d) =>
      d
        .addOption("characters", "Types characters")
        .addOption("meta", "Both act as Meta")
        .addOption("right", "Right Option as Meta")
        .setValue(s().optionKey)
        .onChange(async (v) => {
          s().optionKey = v as TerminalSettings["optionKey"];
          await save();
          core.refreshLook();
        })), { aliases: ["alt", "meta"] }),
    row("Programs can copy to the clipboard", "A program in a terminal can put text on the clipboard, as tmux, vim and ssh sessions do to copy for you, and the terminal's corner says what it copied. Turn this off if you'd rather nothing printed in a terminal could change what Cmd+V pastes. Programs can never read the clipboard.", (st) => st.addToggle((t) =>
      t.setValue(s().programClipboard).onChange(async (v) => {
        s().programClipboard = v;
        await save();
      }))),
    row("Pictures in the terminal", "Lets a program running in a terminal draw pictures and video in it, the way some terminal apps do; Claude Code's pictures use it. Turn it off if pictures ever misbehave: the terminal then ignores them, and pictures already on screen go. With it off, the pictures Claude sends you (a setting under Claude Code) don't show either. A Claude session already running keeps what it found at its start until you restart it.", (st) => st.addToggle((t) =>
      t.setValue(s().showPictures).onChange(async (v) => {
        s().showPictures = v;
        await save();
        core.applyPictures();
      })), { aliases: ["images"] }),
    row("Keep pictures you scroll past cached", "Scrolling back to a picture shows it at once instead of after a pause. Claude Code lets go of pictures far off screen and sends them again when you scroll back; with this on, the terminal keeps what it already drew and uses that. The cost is memory: up to 128 MB per terminal tab, held for as long as the tab is open and freed when it closes. A tab that never shows a picture holds nothing. Turn it off to save that memory; pictures then take a moment to reappear. Off, what's kept goes at once.", (st) => st.addToggle((t) =>
      t.setValue(s().keepPictures).onChange(async (v) => {
        s().keepPictures = v;
        await save();
        core.applyPictures();
      })), { aliases: ["images", "memory", "cache"] }),
    row("Cursor style", "A line sits between characters, as in a text editor, so Shift+arrows visibly start from it. A block covers the character after it, as Terminal.app's does; an underline sits under it.", (st) => st.addDropdown((d) =>
      d
        .addOption("line", "Line")
        .addOption("block", "Block")
        .addOption("underline", "Underline")
        .setValue(s().cursor)
        .onChange(async (v) => {
          s().cursor = v === "block" || v === "underline" ? v : "line";
          await save();
          core.refreshLook();
        }))),
    row("Blinking", "Blink, as Obsidian's editor does.", (st) => st.addToggle((t) =>
      t.setValue(s().cursorBlink).onChange(async (v) => {
        s().cursorBlink = v;
        await save();
        core.refreshLook();
      })), { aliases: ["cursor blink"] }),
    row("Ctrl+C always interrupts", "Off: Ctrl+C copies the terminal's selection when there is one, and otherwise interrupts, as before. On: Ctrl+C always goes to the program as the interrupt, and Cmd+C copies. Cmd+C copies either way.", (st) => st.addToggle((t) =>
      t.setValue(s().ctrlCInterrupts).onChange(async (v) => {
        s().ctrlCInterrupts = v;
        await save();
      }))),
  ];
};

export const linkDefinitions: Section = (core) => {
  const save = saver(core);
  return [
    row("Open links with", "Web addresses, file paths and note names. With a plain click, a click on a link opens it, even in a program that uses the mouse; dragging still selects text. A link a program shows as other text, with the address hidden behind it, still takes Cmd+click.", (st) => st.addDropdown((d) =>
      d
        .addOption("click", "A plain click")
        .addOption("cmd", "Cmd+click")
        .setValue(core.settings.linkClick)
        .onChange(async (v) => {
          core.settings.linkClick = v as TerminalSettings["linkClick"];
          await save();
        }))),
    row("Underline links", "Every web address, file path and note name that opens is underlined, as a link is under the pointer, so it reads apart from other colored text, such as the code an agent writes in backticks.", (st) => st.addToggle((t) =>
      t.setValue(core.settings.markLinks).onChange(async (v) => {
        core.settings.markLinks = v;
        await save();
        for (const view of core.liveViews) view.refreshLinks();
      }))),
  ];
};

export const pythonDefinitions: Section = (core) => {
  const save = saver(core);
  return [
    row("Location of Python 3", "Terminals run through a small Python 3 helper. Leave empty to find Python automatically.", (st) => st.addText((t) =>
      t.setPlaceholder("/opt/homebrew/bin/python3").setValue(core.settings.pythonLocation).onChange(async (v) => {
        core.settings.pythonLocation = v.trim();
        core.forgetPython();
        await save();
      }))),
  ];
};

export function terminalDefinitions(core: VaultTerminal, opts: DefinitionOptions & { headingPrefix?: string; shells?: boolean } = {}): SettingDefinitionItem[] {
  const group = (heading: string, items: SettingDefinition[]): SettingDefinitionItem => ({ type: "group", heading: `${opts.headingPrefix ?? ""}${heading}`, items });
  return [
    ...(opts.shells !== false ? shellDefinitions(core, opts) : []),
    ...agentVariableDefinitions(core, opts),
    ...AGENTS.map((agent) => group(agent.name, agentDefinitions(core, agent))),
    group("Notifications", notificationDefinitions(core, opts)),
    group("Appearance", appearanceDefinitions(core, opts)),
    group("Links", linkDefinitions(core, opts)),
    group("Advanced", pythonDefinitions(core, opts)),
  ];
}
