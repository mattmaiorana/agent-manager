# Hosting vault-terminal

`vault-terminal` is a terminal for Obsidian: real terminals (xterm.js 6 over a small Python helper), built to run Claude Code, Codex and Antigravity unmodified, with their state, notifications, pictures and Mac keys. This folder is all of it. A plugin hosts it by giving it a few things about itself; nothing here imports from outside the folder.

Agent Manager hosts it (`src/plugin/terminal-host.ts`). This file is for any plugin that hosts it.

## Copying it

Copy the whole folder into the host's source, for example as `src/vault-terminal/`. Keep it whole and keep its files as they are, so changes can move between hosts as copies of one folder. Two hosts in one vault with different versions of the folder share its CSS classes, and whichever loads later styles both.

**Packages**, pinned exactly (the terminal was tested on these):

```json
"@xterm/xterm": "6.0.0",
"@xterm/addon-fit": "0.11.0",
"@xterm/addon-search": "0.16.0",
"@xterm/addon-unicode11": "0.9.0"
```

Dev: `esbuild`, `typescript`, `obsidian` (types), `@types/node`.

**The host plugin** must be desktop only (`"isDesktopOnly": true` in its manifest), and for now macOS only: the helper uses macOS's process calls. Its `tsconfig.json` needs `"lib": ["DOM", "DOM.Iterable", "ES2022"]` and `"types": ["node"]`, and its `include` must take in the folder's `py.d.ts` (a glob such as `src/**/*.ts` does).

**At run time** the user needs Python 3.8 or later, found automatically or set in the settings.

## Hosting it

```ts
import { Plugin } from "obsidian";
import { VaultTerminal } from "./vault-terminal/core";
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from "./vault-terminal/settings";
import type { VaultTerminalState } from "./vault-terminal/host";

interface MyData {
  // ...the host's own settings...
  terminal: TerminalSettings;
  terminalState?: VaultTerminalState;
}

export default class MyPlugin extends Plugin {
  data!: MyData;
  terminal!: VaultTerminal;

  async onload() {
    // 1. Load everything first: the terminal reads its settings as it loads.
    const saved = ((await this.loadData()) ?? {}) as Partial<MyData>;
    this.data = {
      ...saved,
      terminal: { ...DEFAULT_TERMINAL_SETTINGS, ...saved.terminal, agents: { ...saved.terminal?.agents } },
    } as MyData;

    // 2. One VaultTerminal per load, made after the data is in.
    this.terminal = new VaultTerminal({
      plugin: this,
      name: "Agent Manager",              // in notices and messages
      viewType: "agent-manager-terminal", // the host's own; two plugins can't share one
      settingsPath: "Settings → Agent Manager → Terminal",
      settings: () => this.data.terminal, // the same object every call
      save: (state) => {
        this.data.terminalState = state;
        return this.save();
      },
      state: this.data.terminalState,
      // Optional: web addresses from a terminal come here instead of going to Obsidian.
      // openUrl: (url) => this.openInMyViewer(url),
    });
    this.terminal.load();
    this.terminal.addCommands(); // optional: the usual open commands
  }

  // The host's one save, used by its own settings and by the terminal's alike.
  async save() {
    this.data.terminalState = this.terminal?.state ?? this.data.terminalState;
    await this.saveData(this.data);
  }

  onunload() {
    this.terminal?.unload();
  }
}
```

**`VaultTerminalHost`** (`host.ts`) is everything the terminal asks of its host. The rules it depends on, each of which fails silently if broken:

- **`settings()` returns the same object every call.** The settings controls change it in place, then call `save`. A copy would make them save nothing.
- **The settings are loaded before the `VaultTerminal` is made,** and `load()` is called after. The terminal reads them as it loads, and the login shell's probe can save within a fraction of a second.
- **`save` saves all of the host's data** from its live objects, never a copy taken at load: the terminal calls it on its own whenever the login shell's PATH changes. `terminal.state` gives the terminal's state at any time, for the host's own saves.
- **`state` is read when the `VaultTerminal` is made.**
- **One `VaultTerminal` per plugin load:** make it in `onload`, `load()` it, `unload()` it in `onunload`.

## Using it

- **Opening terminals.** `terminal.open(kind, "tab" | "right", folder?)`, where `kind` is `"shell"` or an agent id from `agents.ts`: `"claude"`, `"codex"` or `"antigravity"` (Antigravity's id; its program is `agy`). An unknown kind opens a shell. It resolves to the leaf; `leaf.view` is the `TerminalView`. `addCommands()` registers the usual commands for it.
- **A terminal's view** (`TerminalView`, `view.ts`): `programState` (`"working"`, `"waiting"`, `"finished"`, ...), `getDisplayText()`, `text()` (all its text), `typePaths(paths)`, `folder`, `current` (the running session). `terminal.liveViews` holds every open one. There's no event yet when a state changes: read them when needed. Views are made by `makeTerminalView`, never with `new`.
- **The settings screen.** `displayTerminalSettings(containerEl, terminal)` (`settings.ts`) draws every terminal setting into any container, a tab of its own or a section of the host's.
- **Changing settings in code.** Change the object from `settings()`, call `save`, then what the settings controls call: `terminal.refreshLook()` for the font, size, spacing, line height, Option key and scrollback; `terminal.applyPictures()` for "Show pictures"; `terminal.forgetPython()` for Python's location. The rest apply to the next terminal or the next event on their own.
- **Web addresses** a user opens from a terminal go to `host.openUrl` if the host gives one, otherwise to Obsidian (`window.open`), as a link in a note does: Obsidian's Web viewer opens them when that core plugin is on, the browser otherwise.
- **Unloading** ends every session the terminal started.
- `VaultTerminal`'s members marked `@internal` (`sessions`, `closing`, `closingAllowed`, `selfTesting`, `test`, `confirmedWindows`, `lastGuard`, ...) are for the terminal itself and its self-test. A host leaves them alone: setting `closingAllowed`, for one, turns off the confirm before closing a busy agent.

## A controller for each terminal

Agent Manager's sessions need more than a plain terminal: their own command line (a session id, a resume), a strip above the terminal, the tab's name, and a say in closing. A host gives `controller(view)` in its `VaultTerminalHost`, and each new view asks it for a `TerminalController` (`host.ts`) as it's made; return null for a plain terminal. Every member is optional:

- **Starting.** `gated` holds the start until the host calls `view.releaseStart()`; `startHidden` starts it even while its tab isn't showing, at the default size, fitted when shown; `launch(kind, plain)` returns the host's arguments (`args`, placed after the agent's command and never dropped by the retry), its `folder`, and `plain` for a start that mustn't get the terminal's additions, or an `error` to show instead.
- **Slots.** `mount({ top, stage })`: `top` sits above the terminal, which shrinks to fit it; `stage` holds the pane, for an overlay beside it, outside the pane's handlers.
- **Events.** `output(text)` (decoded), `input(data)` (everything the user typed or pasted; the host's own `view.write` isn't counted), `stateChange(state)`, `started(pid)`, `exit(info)` (true: the host takes it from there, as a resume after a failed attach), `launchFailed(message)`, `closed()`.
- **After the program ends.** Enter goes to `restart()` (the host calls `view.restart()`, or refuses); S never starts a shell in a controlled view, and "A shell when an agent ends" doesn't apply. `exitHint()` is the line shown.
- **The tab.** `name()` and `icon()`; the state icons still show over the icon.
- **Closing.** `closeReason(own)` gets the terminal's own reason and returns the one both the tab's and the window's guard use; `draft: true` makes the confirm say there's unsent text. `windowConfirmed(win)` on the host carries out a confirmed close itself (a reload) and returns true; `windowKept(win)` says it was cancelled.
- **State.** `getState()` is saved under the view state's `host` key and given back to `setState()`.
- **The view's side.** `write(data)`, `paste(text)`, `bracketedPaste`, `focus()`, `screenTail(rows)`, `selection`, `running`, `programPid`, `refreshHeader()`.

The settings gained `strippedVariables` (names agents never get, applied after `agentVariables`; by default the API keys and provider switches) and `ctrlCInterrupts` (off: Ctrl+C copies a selection). A host's `openNote(file, line)` takes notes opened from a terminal.

Also: `scrollSpeed` (lines per line of travel, 0.25 to 4, default 1; `wheel.ts`), scroll reports paced a frame apart (`ReportQueue`), and claude given scroll speed 0.25 so each report is one line (`claude.ts`); and the main window's close is held in Obsidian's main process too (`holdMainWindow`), since Obsidian destroys a closing main window 3 s on unless its close event was prevented, so a cancelled confirm used to lose it.

## Links, and a viewer of your own

For a plugin that shows web pages or local HTML files, here is where each kind of link from a terminal goes, and where a viewer can take it over. The code is `openUri` in `view.ts` and `openUrl` and `openPath` in `core.ts`.

- **Web addresses (`http://`, `https://`)** go to the host's `openUrl` if it has one, otherwise to `window.open`, as a link in a note does. A viewer can take them either way:
  - **The viewer hosts the terminal, or its host can call it:** give the host an `openUrl` that hands the address to the viewer. The terminal never sees `window.open` then.
  - **The viewer is a separate plugin:** take over `window.open` as Obsidian's Web viewer does, and terminal links follow with no change to the terminal. Two plugins taking it over (the viewer and the Web viewer) decide between themselves; turn one off.
- **Local files** (a `file://` address, or a path the terminal finds in its text, with `:line` if given) don't go through `openUrl`. They go to `openPath`:
  - **A file inside the vault** opens in Obsidian (`openNote`, in a tab already showing it if there is one). So a viewer that registers its file types with Obsidian (`registerExtensions(["html"], viewType)`) gets in-vault HTML files from the terminal with nothing more.
  - **A file outside the vault** is shown in Finder. A viewer that should open those too needs a hook here like `openUrl` (an `openPath` on the host, tried first), which doesn't exist yet: add it to `VaultTerminalHost` and `openPath` the same way `openUrl` was added.
- **Which clicks open links** is the "Open links with" setting: Cmd+click, or a plain click. A link whose text hides its address always takes Cmd+click.

## Building it

The host's esbuild build passes its options through `withVaultTerminal` from `build.mjs`, which adds the terminal's three needs to whatever the host has, never replacing them:

```js
import { builtinModules } from "node:module";
import { writeFileSync } from "node:fs";
import esbuild from "esbuild";
import { vaultTerminalStyles, withVaultTerminal } from "./src/vault-terminal/build.mjs";

await esbuild.build(
  withVaultTerminal({
    entryPoints: ["src/main.ts"],
    outfile: "main.js",
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
    // the host's own loader, define and plugins go here as usual
  }),
);
writeFileSync("styles.css", hostCss + vaultTerminalStyles());
```

- **`helper.py`** is bundled into `main.js` as text (the `.py` loader) and run with `python3 -I -c`; nothing is written to disk for it.
- **`XTERM_VERSION`** (a define) is the bundled xterm's version, for the terminal's answer to `claude`'s version query. Without it, that answer fails.
- **`xtermInBrowser`** (a plugin) corrects xterm.js's check for Node: Obsidian's renderer has Node, and without the correction xterm sends Option keys wrongly on a Mac. The build stops if a new xterm changes that check.
- **`vaultTerminalStyles()`** is the terminal's CSS with xterm's nested under `.vault-terminal-view`. Append it to the host's `styles.css`.
- Both read `node_modules` from the build's working folder; pass another path as their last argument if the host's packages are elsewhere.

## Names

- Everything of the terminal's own is named `vault-terminal`: CSS classes (`vault-terminal-view`, `vault-terminal-confirm`, ...), escape-sequence ids, temporary folders, `VAULT_TERMINAL_*` environment variables. They're the same in every host, since they describe the same terminal.
- Everything the user reads names the host (`name`, `settingsPath`).
- **The close confirm's hover** is two CSS variables on `.vault-terminal-confirm`: `--vault-terminal-hover-toward` (the color mixed into a button's own on hover: the text color, or white in the dark theme) and `--vault-terminal-hover-amount` (20%, or 28% in the dark theme). A host or a theme can set either.
- A user's shell startup file can skip a slow part while the terminal reads its environment by checking `VAULT_TERMINAL_ENV_PROBE`.

## Two hosts in one vault

Two plugins hosting this terminal can both be on: each runs its own terminals under its own view type, its commands and Dock badge count only its own, and the badge shows the sum. The wrinkles: closing a window with busy agents in both asks twice, once per host; their sessions' process names (`vault-terminal <pid>-<n>`) can match, so the self-test, which audits processes by that name, should run with only one host on.

## Tests

The Node harness (`test/`) tests this folder; it isn't part of it. A host that changes the folder runs it.
