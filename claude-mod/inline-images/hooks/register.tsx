
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

type Size = { width: number; height: number }
type Attachment = {
  path: string
  size: number
  isImage: boolean
  scaled?: { original_width: number; original_height: number }
  upload_error?: string
  partial_error?: string
}
type Result = { caption?: string; attachments?: Attachment[] }
type ReadImage = {
  type?: unknown
  file?: { base64?: unknown; type?: unknown; originalSize?: unknown; dimensions?: { originalWidth?: unknown; originalHeight?: unknown } }
}
type Picture = { path: string; bytes: number; known?: Size; call: string; png?: string }
type Tree = RenderElement

const CELL_ASPECT = 1.9
const MAX_COLUMNS = 120
const MAX_ROWS = 40
const MAX_SCREEN_SHARE = 0.55
const MIN_FRAME = 44
const KEEP_DRAWN = 50
const MAX_PER_GROUP = 4
const MAX_PNG_BASE64 = Math.floor((2 * 1024 * 1024 * 4) / 3)

const sizes = new Map<string, Size>()
const drawn = new Map<string, { key: string; tree: Tree }>()

async function measure($: EngineInterface, a: Picture): Promise<Size | null> {
  const key = `${a.call}\n${a.path}`
  const known = sizes.get(key)
  if (known) return known
  let size: Size | null = null
  if (a.known && a.known.width > 0 && a.known.height > 0) {
    size = a.known
  } else {
    try {
      const r = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', a.path])
      const w = /pixelWidth:\s*(\d+)/.exec(r.stdout)
      const h = /pixelHeight:\s*(\d+)/.exec(r.stdout)
      if (r.exitCode === 0 && w && h) size = { width: Number(w[1]), height: Number(h[1]) }
    } catch {
      /* empty */
    }
  }
  if (size && size.width > 0 && size.height > 0) sizes.set(key, size)
  return size
}

function boxFor(size: Size | null, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  const ratio = size ? size.height / size.width : 9 / 16
  let columns = maxColumns
  let rows = Math.ceil((columns * ratio) / CELL_ASPECT)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(10, Math.floor((rows * CELL_ASPECT) / ratio))
  }
  return { columns, rows: Math.max(3, rows) }
}

function remember(id: string, key: string, tree: Tree): Tree {
  drawn.delete(id)
  drawn.set(id, { key, tree })
  if (drawn.size > KEEP_DRAWN) {
    const oldest = drawn.keys().next().value
    if (oldest !== undefined) drawn.delete(oldest)
  }
  return tree
}

function sendNumber(call: string, path: string): number {
  let h = 2166136261
  for (const ch of `${call}\n${path}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return h % 1_000_000
}

function hasFrames(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { key?: unknown; props?: { key?: unknown; children?: unknown }; children?: unknown }
  const key = n.key ?? n.props?.key
  if (typeof key === 'string' && key.startsWith('frame:')) return true
  const kids = n.children ?? n.props?.children
  return Array.isArray(kids) ? kids.some(hasFrames) : hasFrames(kids)
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const say = async ($: EngineInterface, text: string) => {
  try {
    if ((await $.ui.notify(text, { title: 'inline-images' })).isSent) return
  } catch {
    /* empty */
  }
  $.ui.toast(text)
}

const openIt = async ($: EngineInterface, path: string) => {
  const r = await $.process.run(['open', path])
  if (r.exitCode !== 0) await say($, `Couldn't open it: ${r.stderr.trim() || r.exitCode}`)
}

const saveIt = async ($: EngineInterface, path: string) => {
  const home = await $.env.get('HOME')
  if (!home) { await say($, "Couldn't find your home folder."); return }
  const name = path.split('/').pop() ?? 'image.png'
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n <= 99; n++) {
    const dest = n === 1 ? `${home}/Downloads/${name}` : `${home}/Downloads/${stem} ${n}${ext}`
    await $.process.run(['cp', '-n', path, dest])
    if ((await $.process.run(['cmp', '-s', path, dest])).exitCode === 0) {
      await say($, `Saved to Downloads as ${dest.split('/').pop()}`)
      return
    }
  }
  await say($, "Couldn't save it: too many files with that name in Downloads.")
}

const copyPath = async ($: EngineInterface, path: string) => {
  try {
    if ((await $.ui.copy({ text: path })).isCopied) return
  } catch {
    /* empty */
  }
  await say($, "Couldn't copy the path")
}

const drawable = (path: unknown): path is string =>
  typeof path === 'string' && path.startsWith('/') && /\.png$/i.test(path)

type Site = { requestId: string; viewport?: { columns?: number; rows?: number } }
type Ui = Elements['terminal']

async function framesFor($: EngineInterface, ui: Ui, e: Site, pics: Picture[], caption: string | undefined, more: number):
  Promise<{ frames: Tree[]; measuredAll: boolean } | null> {
  const screenColumns = e.viewport?.columns ?? 100
  const screenRows = e.viewport?.rows ?? 40
  if (screenColumns < 24) return null
  const { Box, Text, Image, Button } = ui
  const room = screenColumns - 4
  const frameMax = Math.min(room, Math.max(MIN_FRAME, Math.min(MAX_COLUMNS + 4, room)))
  const maxRows = Math.max(6, Math.min(MAX_ROWS, Math.floor(screenRows * MAX_SCREEN_SHARE)))
  const frames: Tree[] = []
  let measuredAll = true
  for (const a of pics) {
    const size = await measure($, a)
    if (!size) measuredAll = false
    const box = boxFor(size, frameMax - 4, maxRows)
    const name = a.path.split('/').pop() ?? a.path
    const frameWidth = Math.min(frameMax, Math.max(MIN_FRAME, box.columns + 4))
    const generation = sendNumber(a.call, a.path) * 1_000_000 + box.columns * 1000 + box.rows
    const source = a.png ? { png: a.png } : { file: a.path, format: 'png' as const, generation }
    frames.push(
      <Box key={`frame:${a.call}:${a.path}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={frameWidth} marginTop={1}>
        {/* empty */}
        <Box justifyContent="space-between" columnGap={2}>
          <Box flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">{(pics.length === 1 && caption) || name}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color="inactive">{size ? `${size.width} × ${size.height} · ` : ''}{sizeText(a.bytes)}</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Image key={`image:${a.call}:${a.path}`} source={source} columns={box.columns} rows={box.rows} alt={name} />
        </Box>
        <Box columnGap={2} flexWrap="wrap" marginTop={1}>
          <Button key={`open:${a.call}:${a.path}`} plain label="↗ Open" onPress={() => openIt($, a.path)}><Text color="inactive">↗ Open</Text></Button>
          <Button key={`save:${a.call}:${a.path}`} plain label="Save to Downloads" onPress={() => saveIt($, a.path)}><Text color="inactive">Save to Downloads</Text></Button>
          <Button key={`copy:${a.call}:${a.path}`} plain label="Copy path" onPress={() => copyPath($, a.path)}><Text color="inactive">Copy path</Text></Button>
        </Box>
      </Box>,
    )
  }
  if (more > 0) {
    frames.push(<Text key="more" dimColor>{`and ${more} more ${more === 1 ? 'picture' : 'pictures'} before these`}</Text>)
  }
  return { frames, measuredAll }
}

async function readPicture($: EngineInterface, call: string, path: unknown, output: unknown): Promise<Picture | null> {
  const o = output as ReadImage | null | undefined
  if (!o || typeof o !== 'object' || o.type !== 'image' || typeof path !== 'string' || !path.startsWith('/')) return null
  const f = o.file
  const bytes = typeof f?.originalSize === 'number' ? f.originalSize : 0
  const w = f?.dimensions?.originalWidth
  const h = f?.dimensions?.originalHeight
  const known = typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : undefined
  if (f?.type === 'image/png' && typeof f.base64 === 'string' && f.base64.length <= MAX_PNG_BASE64) {
    return { path, bytes, known, call, png: f.base64 }
  }
  if (!drawable(path)) return null
  try {
    if (!(await $.fs.exists(path))) return null
  } catch {
    return null
  }
  return { path, bytes, known, call }
}

async function withFrames($: EngineInterface, ui: Ui, e: Site, own: Tree | null, pics: Picture[], caption?: string, more = 0): Promise<Tree | null> {
  if (own && hasFrames(own)) return own
  const key = `${e.viewport?.columns ?? ''}|${e.viewport?.rows ?? ''}|${caption ?? ''}|${more}|${pics.map(p => `${p.call}:${p.bytes}:${p.known?.width ?? ''}x${p.known?.height ?? ''}:${p.path}`).join('|')}`
  const kept = drawn.get(e.requestId)
  let frames = kept && kept.key === key ? kept.tree : null
  if (!frames) {
    const made = await framesFor($, ui, e, pics, caption, more)
    if (!made) return null
    frames = <ui.Box flexDirection="column">{made.frames}</ui.Box>
    if (made.measuredAll) remember(e.requestId, key, frames)
  }
  return (
    <ui.Box flexDirection="column">
      {own}
      {frames}
    </ui.Box>
  )
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolResult', props: { tool: 'SendUserFile' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.isExpanded) return next(e)
    const output = e.props.output as Result | undefined
    const all = output?.attachments ?? []
    const pngs = all.filter(a => a.isImage && drawable(a.path))
    if (!pngs.length) return next(e)
    const troubled = all.some(a => a.upload_error || a.partial_error)
    const own = pngs.length < all.length || troubled ? await next(e) : null
    const pics = pngs.map(a => ({
      path: a.path,
      bytes: a.size,
      known: a.scaled ? { width: a.scaled.original_width, height: a.scaled.original_height } : undefined,
      call: e.requestId,
    }))
    return (await withFrames($, $.ui.resolve(e), e, own, pics, output?.caption?.trim())) ?? own ?? next(e)
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'Read' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isRunning || e.props.isErrored || e.props.isInterrupted) return next(e)
    const pic = await readPicture($, e.props.tool_use_id, (e.props.input as { file_path?: unknown } | null)?.file_path, e.props.output)
    if (!pic) return next(e)
    const own = await next(e)
    return (await withFrames($, $.ui.resolve(e), e, own, [pic])) ?? own
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)
    const latest = new Map<string, { call: string; input: unknown; output: unknown }>()
    e.props.calls.forEach((c, i) => {
      if (c.tool !== 'Read' || c.isRunning || c.isErrored || c.isInterrupted) return
      const path = (c.input as { file_path?: unknown } | null)?.file_path
      if (typeof path !== 'string') return
      latest.delete(path)
      latest.set(path, { call: c.tool_use_id ?? `${e.requestId}#${i}`, input: path, output: c.output })
    })
    const pics: Picture[] = []
    for (const r of latest.values()) {
      const pic = await readPicture($, r.call, r.input, r.output)
      if (pic) pics.push(pic)
    }
    if (!pics.length) return next(e)
    const shown = pics.slice(-MAX_PER_GROUP)
    const own = await next(e)
    return (await withFrames($, $.ui.resolve(e), e, own, shown, undefined, pics.length - shown.length)) ?? own
  })
}
