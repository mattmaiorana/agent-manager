// The terminal's picture test mod. Loaded only by the
// self-test, with --plugin-dir. /tlpic <path|png|rgba> draws a known picture
// in the conversation, in the row its command prints, from the source named:
// a PNG file's path, PNG bytes, or RGBA bytes. Then it replaces the picture a
// few times, by a redraw and by $.ui.blit, and finally removes it from the
// conversation; with "stay" after the source (/tlpic png stay), it's left as
// drawn. Each step is a dim transcript line, and with TL_PIC_LOG set,
// a line in that file, so the self-test can line the steps up with the bytes.
import { WIDTH, HEIGHT, PNG_A, PNG_B, RGBA_A, RGBA_B } from './fixtures.js'

const COLUMNS = 24
const ROWS = 8
// After the command: replace by redraw, by blit, by blit, by redraw, then remove.
const STEPS = [
  [2000, 'redraw', 'b'],
  [3500, 'blit', 'a'],
  [5000, 'blit', 'b'],
  [6500, 'redraw', 'a'],
  [9000, 'remove', null],
]

let runs = 0
// Each run's row: which source, which picture, whether it's been removed, and where it's drawn.
const rows = new Map()

function source(root, mode, pic) {
  if (mode === 'path') return { file: `${root}/pictures/${pic}.png`, format: 'png' }
  if (mode === 'rgba') return { rgba: pic === 'a' ? RGBA_A : RGBA_B, width: WIDTH, height: HEIGHT }
  return { png: pic === 'a' ? PNG_A : PNG_B }
}

let logText = ''

async function note($, text, quiet = false) {
  if (!quiet) $.ui.log(text)
  logText += `${Date.now()} ${text}\n`
  const file = await $.env.get('TL_PIC_LOG')
  if (file) await $.fs.write(file, logText)
}

// What the render hook saw, once per row, for the log.
const seen = new Set()

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'tlpic', description: 'Terminal picture test', argumentHint: '<path|png|rgba> [stay]', immediate: true })
    } catch (err) {
      await note($, `tlpic not registered: ${err}`)
    }
    return next(e)
  })

  on('command.run', { command: 'tlpic' }, async ($, e) => {
    const [given, stay] = e.args.trim().split(/\s+/)
    const mode = ['path', 'png', 'rgba'].includes(given) ? given : 'png'
    const id = ++runs
    const row = { mode, pic: 'a', removed: false, requestId: null }
    rows.set(id, row)
    await note($, `tlpic ${id}: show a (${mode})`)
    for (const [ms, how, pic] of stay === 'stay' ? [] : STEPS) {
      $.clock.after(ms, () => {
        void (async () => {
          if (how === 'remove') {
            row.removed = true
            $.ui.invalidate('ui.render')
            await note($, `tlpic ${id}: remove`)
          } else if (how === 'redraw') {
            row.pic = pic
            $.ui.invalidate('ui.render')
            await note($, `tlpic ${id}: redraw to ${pic}`)
          } else {
            row.pic = pic
            const result = row.requestId ? await $.ui.blit({ requestId: row.requestId, key: 'pic', source: source($.plugin.root, mode, pic) }) : { deny: 'not drawn yet' }
            await note($, `tlpic ${id}: blit to ${pic}: ${result.deny ? `denied: ${result.deny}` : 'ok'}`)
          }
        })()
      })
    }
    return { text: `tlpic ${id} ${mode}` }
  })

  // Every site offered, once each by name, for the log.
  const sites = new Set()
  on('ui.render', async ($, e, next) => {
    if (!sites.has(e.component)) {
      sites.add(e.component)
      await note($, `site offered: ${e.component} on ${e.surface}`, true)
    }
    return next(e)
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!seen.has(e.requestId)) {
      seen.add(e.requestId)
      await note($, `render: ${JSON.stringify({ requestId: e.requestId, surface: e.surface, props: e.props, viewport: e.viewport }).slice(0, 600)}`, true)
    }
    if (!String(e.props.command).includes('tlpic')) return next(e)
    const id = Number((String(e.props.text).match(/tlpic (\d+)/) ?? [])[1])
    const row = rows.get(id)
    if (!row) return next(e)
    row.requestId = e.requestId
    const { Box, Text, Image } = $.ui.resolve(e)
    if (row.removed) return Text({ children: [`tlpic ${id}: removed`] })
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: [`tlpic ${id} (${row.mode}):`] }),
        Image({ key: 'pic', source: source($.plugin.root, row.mode, row.pic), columns: COLUMNS, rows: ROWS, alt: `tlpic picture ${row.pic}` }),
        Text({ children: [`tlpic ${id} end`] }),
      ],
    })
  })
}
