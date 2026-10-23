---
name: wrap
description: Wrap up the current session - summarize what was done, where things stand, and what's still open, and file it in the session's ticket if it has one. Use when the user asks to wrap, close out, or checkpoint a session.
disable-model-invocation: true
---

# Wrap

End the session cleanly, so the next one (or the user, tomorrow) can pick up without rereading the conversation. Keep it short.

## 1. Summarize

If this session works on a ticket (step 3 says how to tell), read the ticket first: its earlier wraps and notes may hold open items this conversation never mentioned, and they count too.

Three parts, a few lines each:

- **Done:** what this session did, naming each file it created or changed by its path.
- **Where things stand:** what works, what was tested and what wasn't, and anything decided along the way.
- **Still open:** each loose end as its own line: a question nobody answered, a step not taken, a check not run.

Say plainly what wasn't finished. A summary that sounds complete when it isn't is worse than none.

If there's a ticket, write this summary into its Wrap section now (as step 3 describes), ending with `Open items: waiting on you`, so it's saved even if the user closes the session. Step 2 then brings it up to date, and step 3's question about `done` comes last.

## 2. Settle the open items

For each open item, ask the user whether to finish it now, move it somewhere it will be seen (an existing ticket's AI Notes, a project note, a to-do list; ask where; a new ticket is the user's to make), or drop it. Don't move or drop anything until they answer. Then do what they said, and check each move landed. Only then is the summary's last line `Open items: none`, or `Open items: moved to <where>`; if anything is still waiting, say what.

## 3. File it in the ticket, if there is one

A session works on a ticket when its opening said so, when the user names one, or when a ticket lists this session under its Session Links (the Agent Manager adds them). If you're not sure which ticket, or there may be more than one, ask.

Write the summary into the ticket's `## Wrap` section, under a heading of its own: `### <YYYY-MM-DD> (<CLI>, <session name>)`, using the name on the session's tab in the Agent Manager (ask if you don't know it). If an earlier wrap of this session already has a heading there, update that one in place; if you can't tell whether a heading is this session's or another's, ask rather than overwrite. Never change another session's heading, the user's own notes, or anything else outside the Wrap section, except the `done` property below. If the ticket has no Wrap section, add one at the end. Once the open items are settled, ask whether the ticket's work is done; if the user says so, set its `done` property to true, which moves it out of the tickets base's Open view.

With no ticket, give the summary in the reply and ask whether the user wants it saved anywhere.

## 4. Follow the house rules

If this folder's AGENTS.md (or CLAUDE.md, for Claude Code) says how work is saved or committed, do that before you finish, and say what you did. Before committing a ticket, check its diff: it holds the user's own notes, and edits of theirs go in a commit of their own, or ask.
