# Changelog

All notable changes to Agent Manager are recorded here, in [Keep a Changelog](https://keepachangelog.com) format. The first release is 1.0.0.

## [Unreleased]

## [1.3.0] - 2026-10-23

Onboarding: Set up this vault, with starter skills.

### Added

- **Set up this vault (experimental).** A session, named "Vault setup", that helps you set the vault up for agents: it asks what the vault is for and what's off limits, looks around, and offers an `AGENTS.md`, a rule for where files go, and optional extras (projects, skills, a wrap skill, tickets, agent profiles), each written only when you say yes. It reads its instructions from a guide the plugin keeps in its own folder (`guides/vault-setup.md`), so the opening is short. In the sidebar while there's no `AGENTS.md`, under Advanced & experimental in settings, and in the command palette; when a setup session ran before, it offers to resume it or start fresh. Rather than only describe projects and tickets, it offers an example project (an overview, a decisions note, a sample ticket its overview lists, and a ticket for the setup itself, with the setup session as its main session), ends its report with what to open and try first and an offer to answer questions (from the README, which ships beside the guide), keeps what it says short for people new to all this, and recommends which of your own folders could be projects. It opens with a short welcome, offers git first (explained for people who've never used it), and asks whether to go step by step or set things up on its own and report back; either way it asks before changing anything already in the vault. It stays experimental: an AI does the work, so results vary with the CLI and model.
- **Starter skills**, `wrap` and `second-opinion`, in `skills/`: written into the plugin's folder, offered by Set up this vault, and copied into your skills folder only when you say yes. Once copied they're yours; the plugin never changes a copy. Both run only when asked. The second opinion's commands keep each reviewer as close to read-only as its CLI allows (tested on Claude Code, Codex, and Antigravity).
- **Tips for each CLI** in the README.
- **Attach to a ticket as its main session**, in a session tab's menu: the ticket's Resume opens this session, and a main session it had becomes Previous main. Only when asked; a plain attach still never takes main.

### Changed

- The settings' Advanced section is now **Advanced & experimental**.
- **Overviews are now Project overviews**, in settings and the folder menu (**Add a project overview to this folder**), so it's clear what they are.
- **Turning tickets on turns project overviews on too**, since a ticket's session reads its project's overview. Project overviews can still be turned off on their own.
- **A link that starts a session asks first**, since a link can come from a web page or a note someone else wrote. Starting from a ticket (the tickets board's Launch) doesn't ask. A resume link asks only when the session ran outside this vault.
- **Cmd+A in Claude Code selects what you've typed** in its input box. In its full-screen mode it's Claude Code's own selection, made as a drag would make it, so Backspace deletes it and Cmd+C copies it as they do after a drag; otherwise the terminal selects it, and Backspace or Delete clears the input without interrupting Claude Code. Elsewhere Cmd+A no longer selects the whole terminal; that's **Select all** in the terminal's right-click menu.
- **Every copy in the terminal shows a notice** with the start of what was copied: yours (Cmd+C, Ctrl+C, Copy in the menu) and a program's, so text you didn't copy yourself is never a surprise on a paste.
- The README and the plugin's description say desktop and macOS only, for now.
- **Set up** and **Add** (an agent profile) in settings show a clear hover, as the terminal's confirm buttons do; Obsidian's own barely shows on a plain button.

### Removed

- **Create AGENTS.md**, the sidebar's starter file, replaced by Set up this vault.

### Fixed

- Cmd+clicking a folder inside the vault shows it in Obsidian's file explorer, not Finder.
- A path with an apostrophe in a name (`Projects/Sam's Project/Overview.md`) can be Cmd+clicked; a path after a possessive (`README.md's`) links without the `'s`.
- Hovering a long line in the terminal no longer checks the same file paths again for every row: a line's paths are found once and kept for a moment.
- The terminal reads macOS's default PATH once per load, not on every launch.
- An agent stopped with Ctrl+C right after it starts is no longer started again without the terminal's additions.
- A closed terminal tab no longer stays hooked into its tab's close.
- The session list stays fast with thousands of Codex sessions: it no longer reads every session file again once there are more than 4,096.
- A session still waiting for its transcript looks for it less often as time goes on, rather than searching every CLI's sessions several times a second.
- Renaming or moving a transcript note no longer starts a second one: the session keeps writing to it wherever it is.
- Renaming the transcripts folder, or the folder for sent files, in the file explorer updates the setting, so new transcripts don't go to a new copy of the old folder.
- A ticket that appears without you making it (an agent writing it, sync, git) no longer opens a "which project?" picker; only one you're working in does.
- Resuming a Claude session with an agent profile reads only the end of a long transcript.
- A double quote in a session's name no longer cuts the name short for Codex and Antigravity.
- A line break in a value an opening fills in (a multi-line `repo:` property) no longer sends the opening early.
- Added folders saves when you leave the field, not on every keystroke.
- A transcript note written to by the session and by its transcript view at once no longer loses one of the writes: both take the same lock.
- A folder setting (the ticket template, the sent-files folder, the tickets note) that points outside the vault is ignored rather than followed.
- A session id that isn't a well-formed id is never passed to the CLI on a resume or a fork.

## [1.2.0] - 2026-10-22

Agent profiles.

### Added

- **Agent profiles.** Turn on Use agent profiles and add one (a name, an instructions note, an optional home folder, and its own Daily Chat name), and sessions start with it: Claude Code gets it as an agent (`--agents` and `--agent`), Codex as developer instructions, and every CLI's opening names it and its note. There are none until you add one.
  - A session started from a note or folder in a profile's home folder starts with that profile (the deepest home wins); one started outside every home starts with the **Default agent profile**, No agent profile unless set. A session started from the sidebar, Daily Chat, or the New session command starts with the profile picked on the sidebar's switch.
  - **The switch**, at the top of the sidebar: two choices are a pill whose purple thumb slides to the one picked, more a dropdown. Either is the height of the System Dashboard and Daily Chat buttons below it, in their titles' type. It picks who new sessions and Daily Chat start as, and Pinned and Recent list only that choice's sessions. A session with no agent profile (or one the plugin didn't start) is listed under the Default agent profile; while that's No agent profile, No agent profile is a choice of its own on the switch, with its own list and Daily Chat.
  - **One Daily Chat per profile per day**, named by the profile's own Daily Chat name (`{{profile}} Daily Chat - {{date}}` by default). The sidebar's button says whose it is (Alpha Daily Chat), changing with the switch; with No agent profile picked it's Daily Chat.
  - **Transcripts per profile**, in a folder of the profile's name in the transcripts folder, with an `agent` property. Renaming a profile renames its folder.
  - Side chats and Continue Session keep the profile of the session they came from.
  - **Move to agent profile…**, in a session's menu on the sidebar and on its strip, files it under another profile: its list, its transcript folder, and what sessions continued from it start with. The conversation itself keeps the profile it started with, since neither Claude Code nor Codex changes it on a resume.
  - A new opening part, **Agent profile**, sent first: "You are the {{profile}} agent…".
  - **Add an agent profile** opens a popup for its name, instructions note, home folder, and Daily Chat name; it sits at the top of the section, above Default agent profile.
  - **Each profile can be turned off** without losing its settings: it leaves the switch, homes, and the Default agent profile, and its sessions are listed as if they had no agent profile until it's back on.
  - **Words:** what you add in settings is an agent profile everywhere you see it, since every session is an agent; a profile is only who it starts as.

### Changed

- Settings: each CLI's first switch is **Enable** (was "Offer for new sessions"); **Default CLI**, now **Default backend (CLI)**, lists only the enabled CLIs and says it's what a ticket with no `backend` starts on; **Openings** moved down, just above Advanced.
- Daily Chat sits above the Tickets button.

## [1.1.0] - 2026-10-22

Tickets, with overviews to go with them.

### Added

- **Tickets.** Turn on Use tickets and a note with `type: ticket` is a ticket: a session started from it gets the ticket opening, which says to read it for context and wait. The ticket template (`Templates/Ticket.md` by default, a setting) is never one.
  - Turning tickets on creates `Tickets.base` in the AGENTS.md folder and the ticket template, each only where it's missing. The base lists every ticket in three views (Open, grouped by project; Done; This folder), with Done, Chat (a Launch or Resume pill), Ticket, Project (worked out from its folder), CLI, Created, and Updated.
  - A ticket has one main session: launching it again while that session is open, or still starting, goes to its tab. Its `backend` property picks the CLI.
  - Each session started from a ticket, or found in one on a resume, keeps its lines in the ticket: a resume link under `## Session Links`, labeled with its name, its CLI, and its kind (Main, Previous main, Side session, Linked, Re-hosted, or Continued), and a link to its transcript note under `## Transcripts`. Each line is matched by the session's full id, so a rename updates it in place.
  - **Attach to a ticket**, in a session tab's menu: pick any ticket, and the session's lines go on it as Linked, kept current while it's open. It never takes the ticket's main session, and a session can be attached to several.
  - A ticket made outside any `Tickets/` folder (the base's New button puts one in the default folder for new notes) gets one question: which project it's for, from the folders with an overview, or leave it where it is. Picking one moves it into that project's `Tickets/` folder, keeping links to it.
  - A **Tickets** button above Daily Chat opens the tickets base, or a note set in settings, under a name set there. It can be turned off. A note it opens keeps it when renamed.
  - The strip shows a ticket icon for a session started from a ticket or attached to one; it opens the ticket.
  - **New ticket** (a command, and "New ticket here" in a folder's menu) makes one from the template in the folder's `Tickets/` folder, with its name ready to type.
- **Overviews.** Turn on Use overviews and a folder with an `Overview.md` (the name is a setting) is a project: a session started from a note or a folder below it is first told to read every overview from the AGENTS.md folder down, broadest first, and the repo the nearest one names in its `repo` property. Both parts of that opening are settings.
- **Add an overview to this folder**, in a folder's menu while overviews are on, makes one from a template (a setting, with a short one built in).
- **Wrap**, on every session's strip: types the Wrap message setting (a request for a summary by default; empty hides the button). A message like `/wrap` runs a skill, and goes to Codex as `$wrap `, the way Codex invokes one.
- **Continue Session** replaces the strip's Side chat button. On a session started from a note it offers a side session or a new main session, on any CLI; on any other session, a new session. Then two choices: Keep full context (a copy of the conversation, on the same CLI) or Read the transcript (on another), and the light one: Read the ticket, Read the note, or Read the last message only. A new main session takes the note's main session over once it starts.
- **Files Claude sends you are saved in the vault.** Each file a Claude session sends (its SendUserFile tool) is copied where Obsidian puts a new attachment for the note the session was started from, or into a folder set in settings, and shown in the session's transcript note. A copy never overwrites, and one that fails is tried again on the next turn. It can be turned off.

### Changed

- Every setting that takes a folder or a note suggests them as you type, on Obsidian's own suggestion list, alphabetical.
- Settings show a section's own settings only while its switch is on: overviews, tickets, the Tickets button, and each CLI's while it's offered, and turning one on or off keeps your place on the page.
- The plugin no longer reads Obsidian's deprecated `workspace.activeLeaf`: the focused tab comes from the active view (`getActiveViewOfType`), in the main area or a sidebar alike.
- A session started from a folder records the folder in its transcript note's `source` (as its path with a trailing slash), so a resume knows where it started.
- The starter AGENTS.md tells agents where files go: in a `Files/` folder beside the note they belong to, since agents don't read Obsidian's attachment setting.

## [1.0.1] - 2026-10-21

### Added

- **The pictures Claude sends you, in the terminal.** A Claude Code mod ships inside the plugin and draws each PNG a Claude session sends (SendUserFile) as a framed picture, with Open, Save to Downloads, and Copy path, capped in height so scrolling stays smooth. The plugin writes it into its own folder and passes it to every Claude start and resume with `--plugin-dir` while "Show pictures" is on; nothing is downloaded or written to `~/.claude`. Its look and some of its speed-ups come from show-your-work (MIT, credited). The mod is also a marketplace for installing it by hand (`claude-mod/`); a copy installed that way and the bundled one don't draw a picture twice.

### Fixed

- A tab whose saved backend name is one every JavaScript object inherits ("constructor") now falls back to Claude, as an unknown name always did, instead of breaking the tab (found by Codex reviewing the TypeScript conversion).
- From Obsidian's plugin checker: the manifest's description no longer says "Obsidian"; the plugin's own CSS has no `!important` (two remain in xterm's, which the build appends) (a hidden row uses Obsidian's own `toggle`, and the sidebar's tab-title rule wins by being specific); the starting-folder picker asks Obsidian for folders (`getAllFolders`) instead of listing every file in the vault.
- A picture a program draws (kitty graphics) no longer shows a pointing hand, since clicking it does nothing, nor a thin colored line beside it.
- Large pictures scroll smoothly: each row of a picture is drawn at once, not each cell (about 2 ms a paint for a full-width screenshot).

### Changed

- The release workflow uses current actions on Node 24 (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/attest@v4`) and builds with Node 24, ahead of GitHub retiring Node 20.
- The notice shown when the login shell's environment can't be read explains `VAULT_TERMINAL_ENV_PROBE` itself, rather than pointing at the README.
- The plugin is TypeScript now: the plugin class and its parts (`src/plugin/`), the session tab (`src/sessions/`, with its transcript overlay and its note write-back), the sidebar (`src/browser/`), the transcript writer and the import, the settings tab, the dialogs, Live Preview's link pills, the constants, and the shared data types, checked by the typecheck and by lint rules that refuse untyped values there. No change in behavior, except that opening a transcript note whose path is a folder now says the note isn't written yet instead of trying to open the folder.

## [1.0.0] - 2026-10-21

### Added

- A terminal inside Obsidian for Claude Code, Codex, and Antigravity, with sessions in a sidebar: a New Session button that opens the new-session card (a name and the CLI; the session is told by default to greet you and ask what you'd like, reading nothing beyond AGENTS.md until you say), Daily Chat, then Pinned (in an order you drag) and Recent (open sessions first, then every other session in the vault, newest first, 20 at a time, with a search over their names).
- A dot on every session: green while it's open in a tab, an empty ring when it isn't.
- Daily Chat: one row, showing the date (it moves to the new day on its own), with a sun that's grey until the day's chat has run, yellow once it has, and green while it's open, that goes to the day's chat, resumes it, or starts it, named by a setting (`Daily Chat - {{date}}`), with its own opening (by default, that it's for quick questions that may have nothing to do with each other).
- The AGENTS.md folder: every session starts in one folder, the vault's root by default. A session started in a folder below the root isn't given the rest of the vault. The first-run check offers to create a short `AGENTS.md` there when there's none. Sessions started in any folder the plugin has used stay listed after the setting changes.
- A first-run check for Python 3 and the three CLIs. Only the installed CLIs are offered; when none is, or Python is missing, the sidebar says what to install, with each CLI's install command.
- Start a session from any note or folder: the "Start session from this note" command, "Start agent session" in the file menu, or a link (`obsidian://agent-manager?vault=<vault>&op=new&note=<path>`). It's named for the note or folder, sent an opening that points at it (a setting per kind), and a note gets one property, `main-session`, the session's resume link. Its name is fixed, so a base written for one vault works in any. The latest session started from a note holds it. Claude's link is written at launch; Codex's and Antigravity's as soon as their transcript appears, with no need for a second turn. The session's transcript note links back to the note in its `source` property.
- Settings laid out for this plugin: general settings first (default CLI, the AGENTS.md folder, transcripts folder, Daily Chat name, the terminal split, added folders), then the openings, each CLI (offered or not, whether it's installed and how to install it, its command and location), the agents' environment, the terminal, and Advanced.
- Resume a session from the sidebar, from a link (`obsidian://agent-manager?vault=<vault>&op=resume&session=<id>`), or by pressing Enter after it ends. A reloaded window brings its session tabs back.
- Every session saved as a note in one folder (default `Agent Transcripts`), append-only, and a rendered transcript beside the terminal.
- Side chat, on every session's strip: a copy of the conversation so far in a new tab, made by the CLI's own fork (Claude's `--fork-session`, Codex's `fork`, and Antigravity's `/fork`, typed into a new tab on the conversation). If Antigravity's fork doesn't answer, the side chat is a new session that reads the transcript instead, and says so.
- A session that Remote Control or a compaction moves to a new id is followed: its tab, pin, name, and transcript stay with it.
- Sessions started outside the plugin are listed too, named by their first message.
- The licenses of xterm.js and its three addons at the top of `main.js` and `styles.css`, since an install gets only those files, and in `THIRD_PARTY_NOTICES`.
- Agent Manager links in a note, to resume a session or start one, show as pills, in Live Preview and reading view.
- A README for someone starting from an empty vault: install, the first session, starting from a note, a Bases board, links, and everything the plugin reads, runs, and writes outside the vault.
