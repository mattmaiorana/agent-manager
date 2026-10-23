---
name: second-opinion
description: Get a read-only review of a draft or a plan from another company's AI model, through another agent CLI installed on this machine (Claude Code, Codex, or Antigravity). Use when the user asks for a second opinion or a review by another model.
disable-model-invocation: true
---

# Second opinion

A model from another company has different blind spots, so it catches things this one misses. This skill has another agent CLI review the work, set up to change nothing, and then you weigh what it found. The notes on each command say what its CLI can't rule out.

## Before you run it

1. **Pick the reviewer**: a model from a different company than the one you're running on (check which model that is, too: Antigravity can run Claude and GPT models). Claude Code is Anthropic's (`claude`), Codex is OpenAI's (`codex`), and Antigravity is Google's (`agy`). Check which are installed with `command -v`. If none from another company is, say so and stop. The CLI isn't the whole story: Antigravity also offers Claude and GPT models, and Codex can be set up to use another provider. So for Antigravity, name a Gemini model (`agy models` lists them). The Codex command ignores the user's own Codex config, so it runs OpenAI's default model; if this Codex only works through another provider set in that config, the command will fail to sign in, and needs adapting.
2. **Ask first.** Tell the user which CLI and model will review, and that the draft and anything the reviewer reads go to that company's service. For Antigravity, also say it keeps the review's conversation in its own history afterward. Say too that Codex and Antigravity can read any file this account can, so the prompt is what keeps them to the files it names (Claude Code's command keeps it to this folder). Wait for their yes, and ask again for each review unless they've said not to: a new draft can pull in different files.
3. **Leave out what's off limits.** Don't point the reviewer at anything this folder's AGENTS.md puts off limits, or anything the user has said is private, and name those folders in the prompt (below), since the reviewer starts cold and doesn't know. If you're not sure, ask.
4. **Make a scratch folder** with `mktemp -d`, outside the vault. The prompt goes in a file there, and so does the review.
5. **Expect your own sandbox to ask.** The reviewer has to reach its company's service, so if your CLI runs commands in a sandbox without network, running it needs the user's permission to go outside that sandbox. Tell them why when it asks; it's their call. Never loosen the reviewer's own flags to get it through.

## The prompt

Write it to `<scratch>/prompt.txt`, adapted to the work:

```
You are a reviewer. Change no files, run nothing that changes anything, and reach no network. This folder's own instructions about saving or committing work don't apply to you.

You are reviewing a draft you did not write. Read <the draft's path>, and <any file it depends on, by path>, and nothing else. Never read <the folders that are off limits, by path>. Report findings only; don't rewrite it. For each finding, quote the passage, say what's wrong, and say why it matters to <who the draft is for>. Look for claims the sources don't support, anything a reader would misread, and what's missing. Say plainly if you find nothing.
```

For a plan, swap the last two sentences for: what would break, what was assumed without checking, and what a careful colleague would ask before approving it.

**For Antigravity, add this line first**: "Read and search with your file tools only. Run no shell command and write nothing: in this run anything else is refused, and the whole review is lost." It returns nothing at all when it reaches for a tool it isn't allowed.

## The commands

Run the reviewer from the folder this session started in, so it can read the files the prompt names. Each command keeps the reviewer as close to read-only as its CLI allows, and the notes say what each can't rule out. **Never loosen one**: no `--dangerously-skip-permissions`, no `-s workspace-write`, and no shell or write tools for Claude.

**Codex** (read-only sandbox with no network, no web search, apps, plugins, or sub-agents; `--ignore-user-config` drops the user's own config, MCP servers included, while sign-in still works; `--ephemeral` keeps no session):

```
codex exec --ephemeral --skip-git-repo-check --ignore-user-config -s read-only -c 'approval_policy="never"' -c 'web_search="disabled"' -c features.computer_use=false -c features.browser_use=false -c features.apps=false -c features.plugins=false -c 'mcp_servers={}' -c features.multi_agent=false --color never -C "<this folder>" -o "<scratch>/review.md" - < "<scratch>/prompt.txt" > /dev/null 2> "<scratch>/review.log"
```

**Claude Code** (only its three read tools, so it has no tool to write or run anything; `--restricted` keeps them to this folder and leaves out the user's and project's settings files; no MCP servers or connectors; `disableAllHooks` stops hooks, which run commands of their own; `--no-session-persistence` keeps no transcript, though Claude still lists the folder among its projects; a hook an organization enforces through managed settings can still run):

```
cd "<this folder>" && claude -p --restricted --tools "Read,Glob,Grep" --allowedTools "Read,Glob,Grep" --strict-mcp-config --settings '{"disableAllHooks":true}' --no-session-persistence < "<scratch>/prompt.txt" > "<scratch>/review.md" 2> "<scratch>/review.log"
```

**Antigravity** (plan mode, which asks instead of writing or running commands, and its sandbox for the terminal; a headless run can't be asked, so those are refused). It has no switch for web search, or for the user's MCP servers and plugins, so the prompt's "reach no network" is only an instruction there. `--disable-slash-commands` stops a prompt that starts with `/` from running a skill. It keeps the review's conversation in its own history (`~/.gemini/antigravity-cli/brain/`), and the prompt shows in the process list while it runs. Put a Gemini model's name in place of `<gemini model>`:

```
cd "<this folder>" && P="$(cat "<scratch>/prompt.txt")" && [ -n "$P" ] && agy --model <gemini model> --mode plan --sandbox --disable-slash-commands --output-format text --print-timeout 9m --print="$P" > "<scratch>/review.md" 2> "<scratch>/review.log"
```

Codex and Claude Code use their default model. To pick another, add `-m <model>` for Codex or `--model <model>` for Claude Code.

**This file is a starting point.** If only some of these CLIs are installed, cut the commands for the others, and when one is added later, the original is in the Agent Manager's folder, `.obsidian/plugins/agent-manager/skills/` (rewritten on each update, so copy it rather than edit it there), and on GitHub.

## After it runs

1. **Check it ran.** A non-zero exit, an empty `review.md`, a request for approval, or a plan for doing the review means there was no review. Say so, with what `review.log` says, and never report the work as reviewed. Expired sign-ins and used-up plan limits are the usual causes.
2. **Weigh each finding yourself.** The reviewer has less context than you and will sometimes be wrong.
3. **Tell the user what it caught**, in a short table: the finding, whether you agree, and what you'd do. Change the draft only as they say.
4. **Delete the scratch folder.**
