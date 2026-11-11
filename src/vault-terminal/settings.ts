
import { Setting } from "obsidian";
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
  ctrlCInterrupts: false,
  cursor: "line",
  cursorBlink: true,
};

type Section = (containerEl: HTMLElement, core: VaultTerminal) => void;
const saver = (core: VaultTerminal) => () => core.saveSettings();

export const shellSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);
  new Setting(containerEl)
    .setName("Shell")
    .setDesc("The program a new terminal runs. Leave empty for your login shell.")
    .addText((t) =>
      t.setPlaceholder(core.defaultShell()).setValue(s.shell).onChange(async (v) => {
        s.shell = v.trim();
        await save();
      }),
    );

  new Setting(containerEl)
    .setName("Shell integration for zsh")
    .setDesc("zsh tells the terminal its current folder and where each prompt starts, for Cmd+Up and Cmd+Down between prompts, Cmd+click on paths relative to where you are, and opening a terminal in the same folder. Your startup files are read as usual and never changed. Applies to new terminals.")
    .addToggle((t) =>
      t.setValue(s.shellIntegration).onChange(async (v) => {
        s.shellIntegration = v;
        await save();
      }),
    );

  new Setting(containerEl)
    .setName("A shell when an agent ends")
    .setDesc("When Claude, Codex or Antigravity exits, its tab becomes a shell in the folder it was working in, with what it printed still above. Off: the tab waits, and Enter starts the agent again or S starts a shell.")
    .addToggle((t) =>
      t.setValue(s.shellAfterExit).onChange(async (v) => {
        s.shellAfterExit = v;
        await save();
      }),
    );
};

export const agentVariableSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);
  new Setting(containerEl)
    .setName("Environment variables for agents")
    .setDesc("One NAME=value per line, given to Claude, Codex and Antigravity on top of what your login shell sets. Applies to new sessions. Saved in this plugin's settings file in the vault, so keep secrets in your shell's startup files instead, which the terminal reads but never saves.")
    .addTextArea((t) => {
      t.setPlaceholder("ANTHROPIC_LOG=debug").setValue(s.agentVariables).onChange(async (v) => {
        s.agentVariables = v;
        await save();
      });
      t.inputEl.rows = 4;
      t.inputEl.addClass("vault-terminal-variables");
    });

  new Setting(containerEl)
    .setName("Variables agents never get")
    .setDesc("One name per line, taken out of every agent's environment after the variables above are added, whether your login shell or this setting set them. By default the API keys and provider switches, so a key in your startup files never moves an agent onto API billing or another provider. Applies to new sessions.")
    .addTextArea((t) => {
      t.setValue(s.strippedVariables).onChange(async (v) => {
        s.strippedVariables = v;
        await save();
      });
      t.inputEl.rows = 5;
      t.inputEl.addClass("vault-terminal-variables");
    });
};

export function agentSettings(containerEl: HTMLElement, core: VaultTerminal, agent: AgentProfile): void {
  const s = core.settings;
  const save = saver(core);
  const mine = () => (s.agents[agent.id] ??= { command: "", location: "" });
  const program = agent.command.split(" ")[0];
  new Setting(containerEl)
    .setName("Command")
    .setDesc(`What the ${agent.name} terminal runs, with any arguments. Quote words that contain spaces.`)
    .addText((t) =>
      t.setPlaceholder(agent.command).setValue(s.agents[agent.id]?.command ?? "").onChange(async (v) => {
        mine().command = v.trim();
        await save();
      }),
    );
  new Setting(containerEl)
    .setName(`Location of ${program}`)
    .setDesc(`The full path to ${program}, if it isn't found automatically.`)
    .addText((t) =>
      t.setPlaceholder(`~/.local/bin/${program}`).setValue(s.agents[agent.id]?.location ?? "").onChange(async (v) => {
        mine().location = v.trim();
        await save();
      }),
    );
}

export type NotifyWhere = "desktop" | "obsidian" | "both" | "none";

export const toDesktop = (where: NotifyWhere): boolean => where === "desktop" || where === "both";

export const toObsidian = (where: NotifyWhere): boolean => where === "obsidian" || where === "both";

export function notificationSettings(containerEl: HTMLElement, core: VaultTerminal, more?: (containerEl: HTMLElement, rows: NotificationRows) => void): void {
  const s = core.settings;
  const save = saver(core);
  const where = (name: string, desc: string, lengthName: string, key: "needsYouTo" | "finishedTo", lengthKey: "needsYouSeconds" | "finishedSeconds") =>
    notificationRow(containerEl, name, desc, lengthName, {
      where: s[key],
      seconds: s[lengthKey],
      onWhere: async (v) => {
        s[key] = v;
        await save();
      },
      onSeconds: async (v) => {
        s[lengthKey] = v;
        await save();
      },
    });
  where(
    "Where \"needs you\" notifications go",
    "Something broke, or won't continue until you look at it: a session asks a question, asks for permission, or stops with an error; something you asked for wasn't sent; a scheduled run fails, waits, or stalls. Desktop: a macOS notification, whose sound and how long it stays are set for Obsidian in macOS's notification settings; choose Desktop or Both to hear about it while you're in another app. Obsidian: in the corner of the session you're looking at, at the top right otherwise. Clicking one takes you to the session or task it's about. None: nothing tells you.",
    "\"Needs you\" notification length",
    "needsYouTo",
    "needsYouSeconds",
  );
  let infoLength: Setting | null = null;
  new Setting(containerEl)
    .setName("Information notices in Obsidian")
    .setDesc("What's happening, where nothing broke and nothing waits on you: a copy or a rename confirmed, a session moved to a new ID, a warning about something you just did. Each has an X that only closes it. Off: none of these appear, so you won't see warnings or errors from what you click either.")
    .addToggle((t) =>
      t.setValue(s.infoNotices).onChange(async (v) => {
        s.infoNotices = v;
        await save();
        infoLength?.settingEl.toggle(v);
      }),
    );
  infoLength = lengthSetting(containerEl, "Information notice length", "How long each information notice stays, all alike.", s.infoSeconds, async (v) => {
    s.infoSeconds = v;
    await save();
  });
  infoLength.settingEl.toggle(s.infoNotices);
  where("When a session finishes its turn", "Where a notification goes when a session finishes its turn and waits for you, or a program in a plain terminal says it's done. The tab shows whether a session is working or done either way. Clicking it takes you to the session.", "Finished turn notification length", "finishedTo", "finishedSeconds");
  more?.(containerEl, notificationRow);
  const hideName = "Hide notifications from the session I'm looking at";
  new Setting(containerEl)
    .setName(hideName)
    .setDesc("When the session in front of you asks a question, asks for permission, stops with an error, or finishes its turn, it doesn't notify you, since you can see it. Other sessions still notify you, and so does anything you asked for that wasn't sent.")
    .addToggle((t) =>
      t.setValue(s.hideLooking).onChange(async (v) => {
        s.hideLooking = v;
        await save();
      }),
    );
  new Setting(containerEl)
    .setName("Waiting count on the Dock icon")
    .setDesc("Obsidian's Dock icon shows how many agent sessions are waiting for you, in this vault and others with it on. Off: this vault's sessions aren't counted.")
    .addToggle((t) =>
      t.setValue(s.dockBadge).onChange(async (v) => {
        s.dockBadge = v;
        await save();
        core.updateBadge();
      }),
    );
  new Setting(containerEl)
    .setName("Status icons on tabs")
    .setDesc("A terminal's tab icon shows what its program is doing: working, waiting for you, finished, or a bell. Off: the tab keeps the terminal's or agent's own icon.")
    .addToggle((t) =>
      t.setValue(s.statusIcons).onChange(async (v) => {
        s.statusIcons = v;
        await save();
        core.refreshLook();
      }),
    );
  new Setting(containerEl)
    .setName("Sound on bell")
    .setDesc("Play a short tone when a program rings the terminal bell, a terminal's own simple way of asking for attention. Claude Code sessions don't use it, since the plugin has Claude notify you as above. The terminal's tab is marked with a bell either way, until you look at it.")
    .addToggle((t) =>
      t.setValue(s.bellSound).onChange(async (v) => {
        s.bellSound = v;
        await save();
      }),
    );
}

const NOTIFY_LENGTHS: [string, string][] = [["5", "5 seconds"], ["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["0", "Until clicked"]];

const lengthSetting = (containerEl: HTMLElement, name: string, desc: string, seconds: number, onChange: (v: number) => Promise<void>): Setting =>
  new Setting(containerEl)
    .setName(name)
    .setDesc(`${desc} Until clicked: it stays until you click it or its X.`)
    .addDropdown((d) => {
      for (const [value, label] of NOTIFY_LENGTHS) d.addOption(value, label);
      return d.setValue(String(seconds)).onChange(async (v) => {
        await onChange(Number(v));
      });
    });

export type NotificationRows = (
  containerEl: HTMLElement,
  name: string,
  desc: string,
  lengthName: string,
  o: { where: NotifyWhere; seconds: number; onWhere: (v: NotifyWhere) => Promise<void>; onSeconds: (v: number) => Promise<void> },
) => void;

const notificationRow: NotificationRows = (containerEl, name, desc, lengthName, o) => {
  let length: Setting | null = null;
  new Setting(containerEl)
    .setName(name)
    .setDesc(desc)
    .addDropdown((d) => {
      for (const [value, label] of [["desktop", "Desktop"], ["obsidian", "Obsidian"], ["both", "Both"], ["none", "None"]]) d.addOption(value, label);
      return d.setValue(o.where).onChange(async (v) => {
        await o.onWhere(v as NotifyWhere);
        length?.settingEl.toggle(toObsidian(v as NotifyWhere));
      });
    });
  length = lengthSetting(containerEl, lengthName, "How long one shows in Obsidian.", o.seconds, o.onSeconds);
  length.settingEl.toggle(toObsidian(o.where));
};

export const appearanceSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);

  new Setting(containerEl)
    .setName("Font size")
    .addSlider((sl) =>
      sl.setLimits(8, 28, 1).setValue(s.fontSize).onChange(async (v) => {
        s.fontSize = v;
        await save();
        core.refreshLook();
      }),
    );

  new Setting(containerEl)
    .setName("Font")
    .setDesc("A font family, as CSS names it. It has to be installed on this computer; a name that isn't falls back to Obsidian's monospace font. The box suggests the common terminal fonts you have. Leave empty for Obsidian's monospace font.")
    .addText((t) => {
      t.setPlaceholder("Obsidian's monospace font").setValue(s.fontFamily).onChange(async (v) => {
        s.fontFamily = v;
        await save();
        core.refreshLook();
      });
      const have = installedFonts(COMMON_TERMINAL_FONTS);
      const list = containerEl.createEl("datalist", { attr: { id: "vault-terminal-fonts" } });
      for (const f of have) list.createEl("option", { attr: { value: f } });
      t.inputEl.setAttr("list", "vault-terminal-fonts");
      t.inputEl.title = `Common terminal fonts: ${COMMON_TERMINAL_FONTS.join(", ")}. Installed here: ${have.join(", ") || "none of them"}.`;
    });

  new Setting(containerEl)
    .setName("Letter spacing")
    .setDesc("Extra space between characters, in pixels.")
    .addSlider((sl) =>
      sl.setLimits(-2, 5, 0.5).setValue(s.letterSpacing).onChange(async (v) => {
        s.letterSpacing = v;
        await save();
        core.refreshLook();
      }),
    );

  new Setting(containerEl)
    .setName("Line height")
    .setDesc("The height of each row, as a multiple of the font's.")
    .addSlider((sl) =>
      sl.setLimits(1, 2, 0.05).setValue(s.lineHeight).onChange(async (v) => {
        s.lineHeight = v;
        await save();
        core.refreshLook();
      }),
    );

  new Setting(containerEl)
    .setName("Scrollback lines")
    .setDesc("How many lines each terminal keeps above its screen. Ten full terminals at 10,000 lines took about 230 MB of Obsidian's memory, and more of the system's; fewer lines use less. Applies to open terminals at once.")
    .addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(s.scrollback)).onChange(async (v) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 0 || n > 1000000) return;
        s.scrollback = n;
        await save();
        core.refreshLook();
      });
    });

  new Setting(containerEl)
    .setName("Scroll speed")
    .setDesc("Lines scrolled per line of wheel or trackpad travel, from 0.25 to 4, the same in a shell's scrollback and in a full-screen program like Claude. At 1, about three lines a mouse notch. Applies to open terminals at once. This isn't Claude's own scroll speed: Agent Manager sets that to 0.25, so Claude moves one line per step instead of jumping three when you scroll slowly, and this setting still decides how far it goes. If you've set Claude's scroll speed or acceleration yourself, yours is used.")
    .addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "0.25";
      t.inputEl.max = "4";
      t.inputEl.step = "0.25";
      t.setValue(String(s.scrollSpeed)).onChange(async (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0.25 || n > 4) return;
        s.scrollSpeed = n;
        await save();
      });
    });

  new Setting(containerEl)
    .setName("Option key")
    .setDesc("What Option does with another key. Characters: it types what your keyboard layout gives (é, @, €). Meta: it sends Escape before the key, for programs that use Meta (Option+Left and Option+Right still move by word either way). Right Option as Meta: the right one sends Meta and the left one still types characters.")
    .addDropdown((d) =>
      d
        .addOption("characters", "Types characters")
        .addOption("meta", "Both act as Meta")
        .addOption("right", "Right Option as Meta")
        .setValue(s.optionKey)
        .onChange(async (v) => {
          s.optionKey = v as TerminalSettings["optionKey"];
          await save();
          core.refreshLook();
        }),
    );

  new Setting(containerEl)
    .setName("Programs can copy to the clipboard")
    .setDesc("A program in a terminal can put text on the clipboard, as tmux, vim and ssh sessions do to copy for you, and the terminal's corner says what it copied. Turn this off if you'd rather nothing printed in a terminal could change what Cmd+V pastes. Programs can never read the clipboard.")
    .addToggle((t) =>
      t.setValue(s.programClipboard).onChange(async (v) => {
        s.programClipboard = v;
        await save();
      }),
    );

  new Setting(containerEl)
    .setName("Pictures in the terminal")
    .setDesc("Lets a program running in a terminal draw pictures and video in it, the way some terminal apps do; Claude Code's pictures use it. Turn it off if pictures ever misbehave: the terminal then ignores them, and pictures already on screen go. With it off, the pictures Claude sends you (a setting under Claude Code) don't show either. A Claude session already running keeps what it found at its start until you restart it.")
    .addToggle((t) =>
      t.setValue(s.showPictures).onChange(async (v) => {
        s.showPictures = v;
        await save();
        core.applyPictures();
      }),
    );

  new Setting(containerEl)
    .setName("Cursor style")
    .setDesc("A line sits between characters, as in a text editor, so Shift+arrows visibly start from it. A block covers the character after it, as Terminal.app's does; an underline sits under it.")
    .addDropdown((d) =>
      d
        .addOption("line", "Line")
        .addOption("block", "Block")
        .addOption("underline", "Underline")
        .setValue(s.cursor)
        .onChange(async (v) => {
          s.cursor = v === "block" || v === "underline" ? v : "line";
          await save();
          core.refreshLook();
        }),
    );

  new Setting(containerEl)
    .setName("Blinking")
    .setDesc("Blink, as Obsidian's editor does.")
    .addToggle((t) =>
      t.setValue(s.cursorBlink).onChange(async (v) => {
        s.cursorBlink = v;
        await save();
        core.refreshLook();
      }),
    );

  new Setting(containerEl)
    .setName("Ctrl+C always interrupts")
    .setDesc("Off: Ctrl+C copies the terminal's selection when there is one, and otherwise interrupts, as before. On: Ctrl+C always goes to the program as the interrupt, and Cmd+C copies. Cmd+C copies either way.")
    .addToggle((t) =>
      t.setValue(s.ctrlCInterrupts).onChange(async (v) => {
        s.ctrlCInterrupts = v;
        await save();
      }),
    );
};

export const linkSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);

  new Setting(containerEl)
    .setName("Open links with")
    .setDesc("Web addresses, file paths and note names. With a plain click, a click on a link opens it, even in a program that uses the mouse; dragging still selects text. A link a program shows as other text, with the address hidden behind it, still takes Cmd+click.")
    .addDropdown((d) =>
      d
        .addOption("click", "A plain click")
        .addOption("cmd", "Cmd+click")
        .setValue(s.linkClick)
        .onChange(async (v) => {
          s.linkClick = v as TerminalSettings["linkClick"];
          await save();
        }),
    );

  new Setting(containerEl)
    .setName("Underline links")
    .setDesc("Every web address, file path and note name that opens is underlined, as a link is under the pointer, so it reads apart from other colored text, such as the code an agent writes in backticks.")
    .addToggle((t) =>
      t.setValue(s.markLinks).onChange(async (v) => {
        s.markLinks = v;
        await save();
        for (const view of core.liveViews) view.refreshLinks();
      }),
    );
};

export const pythonSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);

  new Setting(containerEl)
    .setName("Location of Python 3")
    .setDesc("Terminals run through a small Python 3 helper. Leave empty to find Python automatically.")
    .addText((t) =>
      t.setPlaceholder("/opt/homebrew/bin/python3").setValue(s.pythonLocation).onChange(async (v) => {
        s.pythonLocation = v.trim();
        core.forgetPython();
        await save();
      }),
    );
};

export function displayTerminalSettings(containerEl: HTMLElement, core: VaultTerminal, opts: { headingPrefix?: string; shells?: boolean } = {}): void {
  const heading = (name: string) => new Setting(containerEl).setName(`${opts.headingPrefix ?? ""}${name}`).setHeading();
  if (opts.shells !== false) shellSettings(containerEl, core);
  agentVariableSettings(containerEl, core);
  for (const agent of AGENTS) {
    heading(agent.name);
    agentSettings(containerEl, core, agent);
  }
  heading("Notifications");
  notificationSettings(containerEl, core);
  heading("Appearance");
  appearanceSettings(containerEl, core);
  heading("Links");
  linkSettings(containerEl, core);
  heading("Advanced");
  pythonSettings(containerEl, core);
}
