# Changelog

All notable changes to Agent Manager are recorded here, in [Keep a Changelog](https://keepachangelog.com) format. The first release is 1.0.0.

## [Unreleased]

## [1.4.0] - 2026-11-03

A session keeps its context through a compaction, a Remote Control dot on Claude's strip, a New Ticket button, folding tool output with `/quiet`, and typing over a selection in Claude's input box.

### Added

- **A Remote Control dot on a Claude session's strip**, last on the right: green while you can reach the session from the Claude app or claude.ai, grey while you can't, and hollow until Claude says. Claude's own hooks report it after each turn, so a session disconnected from the phone or claude.ai shows it at its next turn; one you disconnect from Claude's panel in the tab shows it at once. Clicking it types `/remote-control`: on a grey dot that connects the session, and on a green one it opens Claude's Remote Control panel, with the session's link, a QR code, and Disconnect (on a hollow one, whichever applies). Right-click it for Copy claude.ai link, while it's green. "Show Remote Control on the strip" in settings (on by default) turns it off. It only shows what Claude's own Remote Control setting did.
- **A session keeps its context through a compaction**: a session started from a ticket, note, or folder now has where it started, its project's overviews, and its repo written into its system prompt as paths, beside its agent, so it still knows them after the conversation is compacted. Claude gets it on every launch, resume, and side chat (`--append-system-prompt`) and takes it up at its next compaction; Codex gets it at launch, with the agent, and keeps it for the conversation's life; Antigravity still gets it in the opening only. Each part is included only while its part of the opening is on, so emptying a template still means the session isn't told it. What a session was launched from is recorded by its id, follows it to a new id and through a rename, and never takes a ticket attached later, which sent the session nothing; a session started before this falls back to its transcript note's `source`.
- **The note icon shows a session's context**: hovering the strip's ticket, note, or folder icon lists where the session was started from, its overviews, its reads, and its repo, and says whether the session keeps them through a compaction (Claude and Codex, for a session started in 1.4) or has them in the first message only (Antigravity, a session started before 1.4, a re-hosted process). Right-click it to open any of them. A session with a ticket attached but started from nothing says no context was sent.
- **`reads` on a ticket**: a list of notes or folders (wikilinks or vault paths) the session should read too, added after the overviews in the opening and the system prompt. A folder is named as a folder, not opened up; an entry that names nothing is left out and said in a notice at launch.
- **A link that opens today's Daily Chat**: `obsidian://agent-manager?vault=<vault>&op=daily`, with `&agent=<profile>` to pick an agent profile's chat whatever the sidebar's switch shows. It does what the Daily Chat button does (goes to the chat's tab, resumes it, or starts it, never a second one), so an agent can open it for you from another session. It doesn't ask first, since it can only reach the day's one chat and carries no text of its own.
- **The New Session button can be turned off, and renamed**: "Show the new session button" and "New session button name" in settings. Turned off, sessions still start from the command palette, a note's or folder's menu, and Daily Chat.
- **A New Ticket button**, a row under New Session while tickets are on. It opens a card with the ticket's name, its project (picked from a list, never guessed; while agent profiles are on, the switched profile's projects; never one inside a folder named Archive), notes, and the CLI it starts on (your default to start, written to its backend property), beside the buttons. Create makes it in the project's Tickets folder and opens it; Launch ("Show the launch button", on unless turned off) also starts its main session on the CLI picked, named for the ticket. A ticket always needs a name. "Show the new ticket button" and "New ticket button name" in settings, and "Where the card's notes go": first, right under the properties, unless you name a heading in your ticket template for them to go under.
- **Typing, Cmd+V, and Cmd+X over a selection in Claude's input box**, as in any text field. Typing over a selection replaces it, Cmd+V pastes over it, and Cmd+X cuts it (a copy, then a delete). It works on a selection made with a drag, a double click (a word), a triple click (a line), or Cmd+A. Keys you type while the selection is being deleted wait their turn, so fast typing lands in order. A selection in a reply is left alone, and with nothing selected, Cmd+X only copies.
- **Fold tool output, with `/quiet`**: "Fold tool output" under Advanced & experimental in settings (on by default) adds `/quiet` to Claude sessions, and a Quiet button to the strip above them. It folds each tool's output into one line under its header (a file edit to `+3 −1` or "New file, 12 lines", a command to "48 lines of output", a file read to "Read 120 lines"), and back again, redrawing the whole session at once, mid-turn too; `/quiet on` and `/quiet off` set it. Only the tools that produce output fold (file edits, commands, file reads, web fetches and searches, MCP tools); what Claude writes to you stays: its text, its questions, plans, task lists, links, and subagents' reports, and any errors. The transcript is untouched, and Ctrl+O still shows everything. Claude Code remembers the choice between sessions. The Quiet button's icon shows which way it is. It works through a second small Claude Code mod that ships with Agent Manager, loaded only into sessions Agent Manager starts, and needs Claude Code's fullscreen rendering to fold output already shown.
- **Make a ticket from this session**, in a session tab's menu while tickets are on: it opens the New Ticket card with the session's project filled in (when it started from a note or folder in one; a Daily Chat's is left to pick), and Create attaches the session to the new ticket as Linked, so its lines stay current there.

### Changed

- **The Quiet button sits just left of the transcript button** on the strip, so the last three are Quiet, the transcript, and the Remote Control dot.
- **Typing while Agent Manager types into a session stops its Enter**: a command from the strip, Wrap, or the opening is never sent with text you typed while it went in. Your text is put back in the prompt, and the opening tries again. And two lines Agent Manager types at once (a click on the Remote Control dot, then Quiet) never run together: the second waits, or says to try again.
- **Claude's Remote Control panel counts as a question the session is asking**, so nothing from the strip is typed into it while it's open.
- **Right-click the transcript button to open the transcript note.** The button above a session still shows the rendered transcript on a click; its right-click menu now has Open transcript note, which was only in the rendered transcript's own right-click menu.
- **A pinned session shows a faint pin at the right of its row**, as Obsidian marks a pinned note.
- **New Session and New Ticket share one line** while both are shown, each card opening full width below them.
- **The sidebar's header is roomier**: the title is a size larger, and the custom button is larger, with no border until you hover it.
- **New Session is a row under Daily Chat, and its card opens under it and picks an agent profile.** The card grows down from under the row as it opens: the name, then, while there's more than one profile, a dropdown for the one the session starts as (set to the switch's choice until you pick another), then the CLI beside Start. The row takes the card's color while the card is open.
- **The Tickets button is now a custom button, at the top right of the sidebar**: its icon, text, and what it opens are each a setting ("Custom button icon", "Custom button text", "Custom button opens", a note, a base, or a link), so it can open anything. While tickets are on it shows a ticket and opens the tickets note, which the Open tickets command opens too ("Tickets note", which was "Tickets button opens"). "Show the tickets button" and "Tickets button name" are gone rather than carried over: if you'd hidden or renamed the button, do it again with "Show the custom button" and "Custom button text" (empty, it says Tickets).

- **An agent profile's Daily Chat is named `Daily Chat - {{profile}} - {{date}}` by default** (was `{{profile}} Daily Chat - {{date}}`), so every profile's daily chats sort together and are quick to find in a list, the Claude app's on your phone included. A profile with its own Daily Chat name keeps it. A profile on the default whose chat for today already ran under the old name starts a new one today; earlier chats keep their names.
- **Pictures Claude sends you have a setting of their own**, "Show pictures Claude sends you", under Advanced & experimental in settings with the other Claude Code mod, which says what it does: a picture Claude sends is drawn in the session, framed, with Open, Save to Downloads, and Copy path, through a small Claude Code mod that comes with Agent Manager. It was tied to the terminal's picture setting, and still needs it.
- **The Daily Chat button can be turned off**, with "Show the daily chat button" in settings, as the Tickets button already could.
- **Set up this vault creates an agent profile's files before you add the profile**: it drafts each profile's instructions note and home folder, makes them on your yes, and only then asks you to add the profile in settings, whose pickers need them to exist.
- **The rendered transcript loads earlier turns as you scroll up.** A long session's transcript still opens with its latest turns (the last 512 KB), and scrolling near the top now brings in the earlier ones, back to the start, without moving what you're reading. It used to stop there and point you to the transcript note.
- The terminal's "Show pictures" is now "Pictures in the terminal", and its description says plainly that it lets programs draw pictures in a terminal, and that Claude's pictures need it.

### Fixed

- **Opening a session's ticket or note from its strip no longer moves you to another session.** The note opened in the session split for a moment, then moved to the notes side, and the split could be left showing a different session. It now opens on the notes side directly (or goes to its tab if it's already open), as do the transcript note from a session and a transcript opened for a session that can't be resumed.

## [1.3.1] - 2026-10-23

Fixes from Obsidian's automated review, two picture fixes, and the README on more than one computer and your phone.

### Fixed

- In Recent, the last open session keeps its divider when closed sessions are listed below it.
- A long caption on a picture Claude sends is cut short before its size, which no longer wraps onto a second line.
- Copy path on a picture shows one notice, the picture's own (as Save to Downloads does), not a second one from Agent Manager.

### Changed

- The README says to turn Agent Manager on in one computer only, how to keep it off on another under Obsidian Sync, and how to reach sessions on the main computer through Remote Control or SSH. Your phone and Known limits say what can and can't be done from a phone or another computer: a running Claude session can be continued there, but no session can be started in Agent Manager from elsewhere yet.
- The terminal's pictures layer, link tooltip, and color lookup are made with Obsidian's own element helpers, and a leftover `package.json` in `src/` is gone, from Obsidian's automated review.

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
