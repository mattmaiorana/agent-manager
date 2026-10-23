// inline-images: the PNGs Claude sends (SendUserFile) drawn as pictures in the terminal, framed,
// with Open, Save to Downloads, and Copy path. The look and the speed-ups are taken from
// show-your-work by Umer Ansari (MIT; see the repo's README): its rounded frame with the name on
// top and quiet actions under the picture, Copy path, a drawn row kept until what it shows
// changes, a height cap, and a picture redrawn when its box changes size. None of its analytics,
// self-updating, onboarding, video, or history copies.

import type { EngineInterface, Register, RenderElement } from 'claude-code'

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
type Tree = RenderElement

// A terminal cell is about twice as tall as it is wide, a little more in most fonts. The terminal
// centers a picture in its box, so the box is made at least as tall as the picture needs (taking a
// cell as 1.9 times as tall as wide): the picture then fills the box's width and starts at its
// left edge, in line with the actions under it, with any spare room above and below.
const CELL_ASPECT = 1.9
// Inline pictures stay modest (show-your-work's caps): fewer picture cells for the terminal to
// repaint as the transcript scrolls, and a phone screenshot doesn't run for pages.
const MAX_COLUMNS = 120
const MAX_ROWS = 40
const MAX_SCREEN_SHARE = 0.55
// Below this the action row would wrap, so the frame is never narrower.
const MIN_FRAME = 44
// How many drawn rows are kept: enough for a long session's pictures, not unbounded.
const KEEP_DRAWN = 50

// Each picture's size in pixels, by the send it came in and its path: a file made again at the same
// path comes in a new send, so it's measured again. A failed measure isn't kept.
const sizes = new Map<string, Size>()
// Each result row's drawing, by its request id, with what it was drawn for: in Claude Code's
// full-screen view a row is drawn again as it scrolls, and nothing it shows has changed then.
const drawn = new Map<string, { key: string; tree: Tree }>()

// A picture's size: from the tool's own result when it says, else from `sips`, which reads only
// the file's header and has no size limit.
async function measure($: EngineInterface, send: string, a: Attachment): Promise<Size | null> {
  const key = `${send}\n${a.path}`
  const known = sizes.get(key)
  if (known) return known
  let size: Size | null = null
  if (a.scaled && a.scaled.original_width > 0 && a.scaled.original_height > 0) {
    size = { width: a.scaled.original_width, height: a.scaled.original_height }
  } else {
    try {
      const r = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', a.path])
      const w = /pixelWidth:\s*(\d+)/.exec(r.stdout)
      const h = /pixelHeight:\s*(\d+)/.exec(r.stdout)
      if (r.exitCode === 0 && w && h) size = { width: Number(w[1]), height: Number(h[1]) }
    } catch {
      // No sips, or it failed: a 16:9 box this time, and another try next time.
    }
  }
  if (size && size.width > 0 && size.height > 0) sizes.set(key, size)
  return size
}

// The box a picture gets, in cells: as wide as allowed, unless that would make it too tall, in
// which case the height is capped and the width follows.
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

// A whole number for a picture's source, different for each send and path: the terminal draws a
// picture again only when its source changes, and a file rewritten at the same path, even at the
// same byte size, comes in a new send.
function sendNumber(send: string, path: string): number {
  let h = 2166136261
  for (const ch of `${send}\n${path}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return h % 1_000_000
}

// Whether a drawing already holds this mod's frames: a second copy of the mod (the one the
// Agent Manager ships and one installed by hand) would otherwise draw every picture twice.
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

export const register: Register = on => {
  on('ui.render', { component: 'ToolResult', props: { tool: 'SendUserFile' } }, async ($, e, next) => {
    // The full row (ctrl+o) and other surfaces get Claude Code's own drawing.
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.isExpanded) return next(e)
    const output = e.props.output as Result | undefined
    const all = output?.attachments ?? []
    // Absolute paths only: a path starting with "-" would read as an option to open or cp.
    const pngs = all.filter(a => a.isImage && a.path.startsWith('/') && /\.png$/i.test(a.path))
    if (!pngs.length) return next(e)

    const screenColumns = e.viewport?.columns ?? 100
    const screenRows = e.viewport?.rows ?? 40
    // Too narrow for a frame: Claude Code's own card.
    if (screenColumns < 24) return next(e)
    const key = `${screenColumns}|${screenRows}|${output?.caption ?? ''}|${all.map(a => `${a.size}:${a.scaled?.original_width ?? ''}x${a.scaled?.original_height ?? ''}:${a.path}`).join('|')}`
    const kept = drawn.get(e.requestId)
    if (kept && kept.key === key) return kept.tree

    // Files that aren't pictures, or any file with an upload problem, keep Claude Code's own card
    // above the frames, so nothing it would say is hidden.
    const troubled = all.some(a => a.upload_error || a.partial_error)
    const own = pngs.length < all.length || troubled ? await next(e) : null
    // Another copy of this mod, beneath, already framed them.
    if (own && hasFrames(own)) return own
    const { Box, Text, Image, Button } = $.ui.resolve(e)

    const openIt = async (path: string) => {
      const r = await $.process.run(['open', path])
      if (r.exitCode !== 0) $.ui.toast(`Couldn't open it: ${r.stderr.trim() || r.exitCode}`)
    }
    // Copied to ~/Downloads, under a new name if the one it has is taken.
    const saveIt = async (path: string) => {
      const home = await $.env.get('HOME')
      if (!home) { $.ui.toast("Couldn't find your home folder."); return }
      const name = path.split('/').pop() ?? 'image.png'
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      // `cp -n` never overwrites: it fails when the name is taken, even by a save a moment ago,
      // and the next number is tried. `cmp` confirms the file there is this one.
      for (let n = 1; n <= 99; n++) {
        const dest = n === 1 ? `${home}/Downloads/${name}` : `${home}/Downloads/${stem} ${n}${ext}`
        await $.process.run(['cp', '-n', path, dest])
        if ((await $.process.run(['cmp', '-s', path, dest])).exitCode === 0) {
          $.ui.toast(`Saved to Downloads as ${dest.split('/').pop()}`)
          return
        }
      }
      $.ui.toast("Couldn't save it: too many files with that name in Downloads.")
    }

    // The frame's border and padding take four columns.
    const room = screenColumns - 4
    const frameMax = Math.min(room, Math.max(MIN_FRAME, Math.min(MAX_COLUMNS + 4, room)))
    const maxRows = Math.max(6, Math.min(MAX_ROWS, Math.floor(screenRows * MAX_SCREEN_SHARE)))
    const caption = pngs.length === 1 ? output?.caption?.trim() : undefined
    const frames = []
    let measuredAll = true
    for (const a of pngs) {
      const size = await measure($, e.requestId, a)
      if (!size) measuredAll = false
      const box = boxFor(size, frameMax - 4, maxRows)
      const name = a.path.split('/').pop() ?? a.path
      const frameWidth = Math.min(frameMax, Math.max(MIN_FRAME, box.columns + 4))
      // A new send or a new box size makes a new source, so the terminal draws it again.
      const generation = sendNumber(e.requestId, a.path) * 1_000_000 + box.columns * 1000 + box.rows
      frames.push(
        <Box key={`frame:${a.path}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={frameWidth} marginTop={1}>
          <Box justifyContent="space-between">
            <Text bold wrap="truncate-end">{caption || name}</Text>
            <Text dimColor>{size ? `${size.width} × ${size.height} · ` : ''}{sizeText(a.size)}</Text>
          </Box>
          <Box marginTop={1}>
            <Image key={`image:${a.path}`} source={{ file: a.path, format: 'png', generation }} columns={box.columns} rows={box.rows} alt={name} />
          </Box>
          <Box columnGap={2} flexWrap="wrap" marginTop={1}>
            <Button key={`open:${a.path}`} plain label="↗ Open" onPress={() => openIt(a.path)} />
            <Button key={`save:${a.path}`} plain dimColor label="Save to Downloads" onPress={() => saveIt(a.path)} />
            <Button key={`copy:${a.path}`} plain dimColor label="Copy path"
              onPress={async press => {
                const r = await $.ui.copy({ text: a.path, surface: press.surface })
                $.ui.toast(r.isCopied ? 'Path copied' : "Couldn't copy the path")
              }} />
          </Box>
        </Box>,
      )
    }
    const tree = (
      <Box flexDirection="column">
        {own}
        {frames}
      </Box>
    )
    // A drawing with a guessed size isn't kept, so the next draw measures again.
    return measuredAll ? remember(e.requestId, key, tree) : tree
  })
}
