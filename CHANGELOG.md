# Changelog

All notable changes to Agent Manager are recorded here, in [Keep a Changelog](https://keepachangelog.com) format. The first release is 1.0.0.

## [Unreleased]

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
