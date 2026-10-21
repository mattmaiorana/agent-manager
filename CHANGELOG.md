# Changelog

All notable changes to Agent Manager are recorded here, in [Keep a Changelog](https://keepachangelog.com) format. The first release is 1.0.0.

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
