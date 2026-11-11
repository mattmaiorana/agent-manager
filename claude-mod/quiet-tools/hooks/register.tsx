
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isQuiet = atom({ plugin: 'quiet-tools', key: 'isQuiet' } as const, false)
const STORE_KEY = 'isQuiet'
const COMMAND = 'quiet'
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

async function report($: EngineInterface, on: boolean): Promise<void> {
  const file = await $.env.get('AGENT_MANAGER_QUIET_STATE')
  if (!file) return
  try {
    await $.fs.write(file, JSON.stringify({ isQuiet: on }) + '\n')
  } catch {
    /* empty */
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

function mcpText(o: Record<string, unknown>): string | null {
  if (!Array.isArray(o.content)) return null
  const texts = (o.content as unknown[])
    .map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? (part as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string')
  return texts.length ? texts.join('\n') : null
}

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
    const same = tool === 'Write' && typeof o.originalFile === 'string' && o.originalFile === o.content
    return same ? 'Rewritten, no changes' : null
  }
  return `+${counts.added} −${counts.removed}`
}

function summarize(tool: string, output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (o.staged === true) return null
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return editLine(tool, o)
  if (tool === 'Bash') {
    if (o.isImage === true || o.interrupted === true || typeof o.backgroundTaskId === 'string') return null
    if (typeof o.persistedOutputPath === 'string' || o.gitOperation) return null
    const n = lineCount(o.stdout) + lineCount(o.stderr)
    return n ? `${lines(n)} of output` : 'No output'
  }
  if (tool === 'Read') {
    const file = o.file as { numLines?: unknown; truncatedByTokenCap?: unknown } | undefined
    if (o.type !== 'text' || typeof file?.numLines !== 'number' || file.truncatedByTokenCap === true) return null
    return `Read ${lines(file.numLines)}`
  }
  if (tool === 'WebFetch') return typeof o.result === 'string' ? `Fetched, ${lines(lineCount(o.result))}` : null
  if (tool === 'WebSearch') return 'Searched the web'
  if (tool.startsWith('mcp__')) {
    if (o.isError === true) return null
    const text = mcpText(o)
    return text !== null ? lines(lineCount(text)) : 'Output folded'
  }
  return 'Output folded'
}

export const register: Register = on => {
  let ownsCommand = true

  on('session.start', async ($, e, next) => {
    try {
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
    if (e.surface !== 'terminal') return next(e)
    if (!folds(tool) || isErrored || isExpanded === true) return next(e)
    if (!(await read($, isQuiet))) return next(e)
    const line = summarize(tool, output)
    if (line === null) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{'  ⎿  '}{line}</Text>
  })
}
