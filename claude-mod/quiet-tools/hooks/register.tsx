// quiet-tools: /quiet folds the output of the tools that make it (FOLD: file edits, commands,
// file reads, web fetches and searches, MCP tools) into one dim line under each call's header,
// and back again, redrawing every row at once. Every other tool's result is drawn by Claude
// Code, so what Claude writes to you stays: its text, its questions, plans, task lists, links,
// subagents' reports, and anything a new build adds. It changes only what's drawn: the transcript
// and what the model reads are untouched. A row shown in full (Ctrl+O), a call that failed or
// was cut off, and a result with something to say beyond its output (a saved-output file, a
// pull request, a cut read) are drawn by Claude Code too. Needs fullscreen rendering to redraw
// rows already drawn, as /focus does. Shipped inside Agent Manager (claude-mod/README.md).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Whether tool output is folded. Lives in $.state so a toggle redraws every row that read it,
// and in $.store so the choice carries to the next session.
const isQuiet = atom({ plugin: 'quiet-tools', key: 'isQuiet' } as const, false)
const STORE_KEY = 'isQuiet'
const COMMAND = 'quiet'
// The tools whose output is folded, and every MCP tool (`mcp__<server>__<tool>`). A list of
// what to fold rather than what to keep, so a tool that writes for the person, or one a new
// build adds, is never hidden by default (Codex's and Fable's review, 2026-11-03).
const FOLD = new Set([
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'LSP',
  'NotebookEdit',
  'Read',
  'ReadMcpResourceTool',
  'WebFetch',
  'WebSearch',
  'Write',
])

function folds(tool: string): boolean {
  return FOLD.has(tool) || tool.startsWith('mcp__')
}

// Agent Manager names a file per session here, and its strip shows whether quiet is on from it.
// Unset (a copy installed by hand, a session started elsewhere), nothing is written.
async function report($: EngineInterface, on: boolean): Promise<void> {
  const file = await $.env.get('AGENT_MANAGER_QUIET_STATE')
  if (!file) return
  try {
    await $.fs.write(file, JSON.stringify({ isQuiet: on }) + '\n')
  } catch {
    // The strip's icon is a convenience; the toggle works without it.
  }
}

type Hunk = { lines: string[] }

function countHunks(hunks: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(hunks) || hunks.length === 0) return null
  let added = 0
  let removed = 0
  for (const hunk of hunks as Hunk[]) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text.trim() === '') return 0
  return text.replace(/\n+$/, '').split('\n').length
}

function lines(n: number): string {
  return `${n} ${n === 1 ? 'line' : 'lines'}`
}

// The text of an MCP tool's answer (`{ content: [{ type: 'text', text }, ...] }`), or null.
function mcpText(o: Record<string, unknown>): string | null {
  if (!Array.isArray(o.content)) return null
  const texts = (o.content as unknown[])
    .map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? (part as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string')
  return texts.length ? texts.join('\n') : null
}

// A file edit's one line, or null to let Claude Code draw its own.
function editLine(tool: string, o: Record<string, unknown>): string | null {
  if (tool === 'NotebookEdit') {
    if (typeof o.error === 'string' && o.error) return null
    const mode = typeof o.edit_mode === 'string' ? o.edit_mode : 'replace'
    const verb = mode === 'insert' ? 'Inserted' : mode === 'delete' ? 'Deleted' : 'Edited'
    return `${verb} a cell`
  }
  if (tool === 'Write' && o.type === 'create') return `New file, ${lines(lineCount(o.content))}`
  const counts = countHunks(o.structuredPatch)
  if (counts === null) {
    // An empty patch is also a diff that timed out or a file too large to diff, so "no
    // changes" only when the old content is there and matches.
    const same = tool === 'Write' && typeof o.originalFile === 'string' && o.originalFile === o.content
    return same ? 'Rewritten, no changes' : null
  }
  return `+${counts.added} −${counts.removed}`
}

// One line for a tool's result, or null to let Claude Code draw its own.
function summarize(tool: string, output: unknown): string | null {
  // A string is a call an abort or a refusal ended (its own text), never a tool's output.
  if (output === null || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  // Held for the machine owner's review, so the file is unchanged: Claude Code says so.
  if (o.staged === true) return null
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return editLine(tool, o)
  if (tool === 'Bash') {
    // A picture, an interrupted run, one sent to the background, output too large to show
    // (saved to a file, with only its ends in stdout), or a git operation (a pull request's
    // link): Claude Code's own drawing says what happened.
    if (o.isImage === true || o.interrupted === true || typeof o.backgroundTaskId === 'string') return null
    if (typeof o.persistedOutputPath === 'string' || o.gitOperation) return null
    const n = lineCount(o.stdout) + lineCount(o.stderr)
    return n ? `${lines(n)} of output` : 'No output'
  }
  if (tool === 'Read') {
    // Text only, and whole: an image, a PDF, a notebook, or a read cut at the token cap is
    // drawn by Claude Code.
    const file = o.file as { numLines?: unknown; truncatedByTokenCap?: unknown } | undefined
    if (o.type !== 'text' || typeof file?.numLines !== 'number' || file.truncatedByTokenCap === true) return null
    return `Read ${lines(file.numLines)}`
  }
  if (tool === 'WebFetch') return typeof o.result === 'string' ? `Fetched, ${lines(lineCount(o.result))}` : null
  if (tool === 'WebSearch') return 'Searched the web'
  if (tool.startsWith('mcp__')) {
    // An error the server reported is shown, whether or not the row says it failed.
    if (o.isError === true) return null
    const text = mcpText(o)
    return text !== null ? lines(lineCount(text)) : 'Output folded'
  }
  return 'Output folded'
}

export const register: Register = on => {
  // Whether /quiet is this mod's to answer: false when another plugin's command has the
  // name, so its own hook gets the run. Set again by session.start on every load.
  let ownsCommand = true

  on('session.start', async ($, e, next) => {
    try {
      // /quiet may already be listed: this mod's own (from before a reload, or a second copy,
      // which answers it the same way), or something else's, which is left alone and said once.
      // A register of a name already registered replaces it, so only another plugin's matters.
      const taken = (await $.command.list()).find(c => c.name === COMMAND)
      ownsCommand = !taken || taken.plugin === 'quiet-tools'
      if (!ownsCommand && taken) {
        $.ui.toast(`/${COMMAND} is already taken (${taken.source}); quiet-tools did not register it.`)
      } else if (!taken) {
        await $.command.register({
          name: COMMAND,
          description: "Fold each tool's output to one line (toggle; on or off to set)",
          argumentHint: '[on|off]',
          immediate: true,
        })
      }
      // The saved choice applies only to a state never written. Two copies loaded together
      // (one installed by hand, one passed with --plugin-dir) share this state but each has its
      // own store, so the first to start sets it and a reload keeps what the session has.
      const { version } = await $.state.get({ plugin: 'quiet-tools', key: 'isQuiet' } as const)
      if (version === 0) {
        const saved = await $.store.get(STORE_KEY)
        if (typeof saved === 'boolean') await update($, isQuiet, () => saved)
      }
      await report($, await read($, isQuiet))
    } catch (err) {
      $.ui.toast(`quiet-tools could not start: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!ownsCommand) return next(e)
    const arg = e.args.trim().toLowerCase()
    let now = false
    try {
      await update($, isQuiet, was => {
        now = arg === 'on' ? true : arg === 'off' ? false : !was
        return now
      })
      await $.store.set(STORE_KEY, now)
      await report($, now)
    } catch (err) {
      return { text: `quiet-tools could not switch: ${String(err)}` }
    }
    return {
      text: now
        ? "Quiet on: each tool's output is one line. Ctrl+O shows it all."
        : 'Quiet off: tool output is shown in full.',
    }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isErrored, isExpanded } = e.props
    // The terminal only: elsewhere (desktop, mobile) a row may have no way to unfold.
    if (e.surface !== 'terminal') return next(e)
    if (!folds(tool) || isErrored || isExpanded === true) return next(e)
    if (!(await read($, isQuiet))) return next(e)
    const line = summarize(tool, output)
    if (line === null) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{'  ⎿  '}{line}</Text>
  })
}
