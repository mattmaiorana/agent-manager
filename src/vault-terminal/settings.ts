// The terminal's settings: what they are, their defaults, and the controls
// that edit them, for any host plugin's settings tab (PORTING.md). The host
// keeps the values and saves them; displayTerminalSettings shows them.

import { Setting } from "obsidian";
import { AGENTS, type AgentProfile } from "./agents";
import { DEFAULT_STRIPPED_VARIABLES } from "./finder";
import type { VaultTerminal } from "./core";

/** Monospace fonts people commonly use in terminals. Menlo, Monaco and Courier New come with macOS; SF Mono ships inside Terminal.app and has to be installed from there to be usable. */
const COMMON_TERMINAL_FONTS = [
  "SF Mono", "Menlo", "Monaco", "Courier New",
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Hack",
  "IBM Plex Mono", "Iosevka", "Berkeley Mono", "MesloLGS NF", "Victor Mono",
];

/**
 * Which of these fonts are installed: text set in the font measures differently
 * from the same text in a fallback font, against two fallbacks in case the font
 * is one of them.
 */
function installedFonts(names: string[]): string[] {
  const ctx = createEl("canvas").getContext("2d");
  if (!ctx) return names;
  const sample = "mmmmmmmmmmlli10OoWw@#";
  const width = (font: string) => { ctx.font = `32px ${font}`; return ctx.measureText(sample).width; };
  const bases = ["monospace", "serif"].map((b) => [b, width(b)] as const);
  return names.filter((n) => bases.some(([b, w]) => width(`"${n}", ${b}`) !== w));
}

/** An agent's command and where its program is, when the defaults don't do. */
export interface AgentSettings {
  /** Empty means the agent's default command. */
  command: string;
  /** Empty means found automatically. */
  location: string;
}

export interface TerminalSettings {
  /** Empty means the user's login shell. */
  shell: string;
  /** By agent id (agents.ts); a missing entry means the defaults. */
  agents: Record<string, AgentSettings>;
  /** NAME=value lines added to every agent's environment, over the login shell's. */
  agentVariables: string;
  /** Names taken out of every agent's environment after agentVariables are merged, one per line (finder.ts, agentEnv). */
  strippedVariables: string;
  /** Empty means found automatically. */
  pythonLocation: string;
  fontSize: number;
  /** Empty means Obsidian's monospace font. */
  fontFamily: string;
  /** Extra space between characters, in pixels. */
  letterSpacing: number;
  /** Row height as a multiple of the font's. */
  lineHeight: number;
  /** Lines each terminal keeps above its screen. */
  scrollback: number;
  /** Tell the user when claude needs them and they aren't looking. Off by default. */
  notifications: boolean;
  /** The tab's icon shows the program's state (working, waiting, finished, a bell). Off: it always shows the terminal's or agent's own icon. */
  statusIcons: boolean;
  /** Obsidian's Dock icon counts the sessions waiting for you, across vaults. Off: this vault adds nothing to it. */
  dockBadge: boolean;
  /** Option types characters ("characters"), both act as Meta ("meta"), or only the right one does ("right"). */
  optionKey: "characters" | "meta" | "right";
  /** Play a sound on the bell; the tab is marked either way. */
  bellSound: boolean;
  /** When an agent ends, its tab becomes a shell in the same folder; off: wait for Enter or S. */
  shellAfterExit: boolean;
  /** zsh reports its folder and prompts (zsh.ts). Off by default: it wraps the user's startup files. */
  shellIntegration: boolean;
  /** Lines the wheel scrolls per row of travel, 0.25 to 4 (wheel.ts, scrollSpeed); 1 is about 3 lines a mouse notch. */
  scrollSpeed: number;
  /** Links open with Cmd+click ("cmd", the default) or a plain click ("click"). */
  linkClick: "cmd" | "click";
  /** Programs may set the clipboard (OSC 52; spec 54). On by default; reading it is always refused. */
  programClipboard: boolean;
  /** Programs can show pictures and video (kitty's graphics protocol). On by default; off, none of the picture code runs. */
  showPictures: boolean;
  /** Ctrl+C always goes to the program as the interrupt. Off (the default): it copies the terminal's selection when there is one (keys.ts). */
  ctrlCInterrupts: boolean;
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
  notifications: false,
  statusIcons: true,
  dockBadge: false,
  bellSound: false,
  optionKey: "characters",
  shellIntegration: false,
  shellAfterExit: false,
  scrollSpeed: 1,
  linkClick: "cmd",
  programClipboard: true,
  showPictures: true,
  ctrlCInterrupts: false,
};

type Section = (containerEl: HTMLElement, core: VaultTerminal) => void;
const saver = (core: VaultTerminal) => () => core.saveSettings();

/** The three shell settings, for a host with shell tabs. */
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

/** The variables every agent gets, and the names none gets. */
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

/** One agent's Command and Location (and, for Claude, its notifications), without a heading. */
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
  if (agent.id === "claude") {
    new Setting(containerEl)
      .setName("Notify when Claude needs you")
      .setDesc("Off by default; while off, nothing notifies you. On: when Claude asks for permission, finishes, or stops with an error while you're not looking at its terminal, a macOS notification if Obsidian isn't in front, an Obsidian notice if it is. Click it to go to the terminal.")
      .addToggle((t) =>
        t.setValue(s.notifications).onChange(async (v) => {
          s.notifications = v;
          await save();
        }),
      );
  }
}

/** How terminals look and behave: the Dock badge, tab icons, font, scrolling, and keys. */
export const appearanceSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);

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
    .setDesc("A program in a terminal can put text on the clipboard, as tmux, vim and ssh sessions do to copy for you. Turn this off if you'd rather nothing printed in a terminal could change what Cmd+V pastes. Programs can never read the clipboard.")
    .addToggle((t) =>
      t.setValue(s.programClipboard).onChange(async (v) => {
        s.programClipboard = v;
        await save();
      }),
    );

  new Setting(containerEl)
    .setName("Show pictures")
    .setDesc("Programs can show pictures and video in a terminal, as Claude Code's mods do. Turn this off if pictures ever misbehave: the terminal then works as it did without them, and pictures on screen go. A Claude already running keeps what it decided at its start until you restart it.")
    .addToggle((t) =>
      t.setValue(s.showPictures).onChange(async (v) => {
        s.showPictures = v;
        await save();
        core.applyPictures();
      }),
    );

  new Setting(containerEl)
    .setName("Sound on bell")
    .setDesc("Play a short tone when a program rings the bell. The terminal's tab is marked either way.")
    .addToggle((t) =>
      t.setValue(s.bellSound).onChange(async (v) => {
        s.bellSound = v;
        await save();
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

/** How links in a terminal open. */
export const linkSettings: Section = (containerEl, core) => {
  const s = core.settings;
  const save = saver(core);

  new Setting(containerEl)
    .setName("Open links with")
    .setDesc("Web addresses, file paths and note names. With a plain click, a click on a link opens it, even in a program that uses the mouse; dragging still selects text. A link a program shows as other text, with the address hidden behind it, still takes Cmd+click.")
    .addDropdown((d) =>
      d
        .addOption("cmd", "Cmd+click")
        .addOption("click", "A plain click")
        .setValue(s.linkClick)
        .onChange(async (v) => {
          s.linkClick = v as TerminalSettings["linkClick"];
          await save();
        }),
    );
};

/** Where Python 3 is, when it isn't found on its own. */
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

/**
 * Every terminal setting, as controls, into a host's settings tab (or a
 * section of it). The host empties the container first if it needs to. A host
 * that lays its page out itself places the sections above one by one.
 */
export function displayTerminalSettings(containerEl: HTMLElement, core: VaultTerminal, opts: { headingPrefix?: string; shells?: boolean } = {}): void {
  // A host with headings of its own ("Advanced") names these apart.
  const heading = (name: string) => new Setting(containerEl).setName(`${opts.headingPrefix ?? ""}${name}`).setHeading();
  // A host with no shell tabs leaves out the three shell settings.
  if (opts.shells !== false) shellSettings(containerEl, core);
  agentVariableSettings(containerEl, core);
  for (const agent of AGENTS) {
    heading(agent.name);
    agentSettings(containerEl, core, agent);
  }
  heading("Appearance");
  appearanceSettings(containerEl, core);
  heading("Links");
  linkSettings(containerEl, core);
  heading("Advanced");
  pythonSettings(containerEl, core);
}
