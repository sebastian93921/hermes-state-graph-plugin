// Weight + files sections: does the detail box fold in the task's per-tool
// weight bars and the distinct file paths it touched?
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, nodeDetail, $trails, $detail } from './plugin.js'

const contributions = []

host.request = async () => ({ messages: [] })
plugin.register({
  source: 'p',
  register: item => {
    contributions.push(item)
    return () => {}
  },
  registerMany: items => items.forEach(item => contributions.push(item)),
  onDispose: () => {},
  rest: async () => ({}),
  socket: () => () => {},
  os: { revealPath: async () => true },
  storage: { get: async () => null, set: async () => {} },
  i18n: { register: () => {} }
})

const pane = contributions.find(item => item.area === 'panes')
// the pane shell carries the relocated weight/files rows; GraphView keeps the
// rows themselves, so both surfaces are asserted below
const renderFrame = () => renderToString(pane.render())

const SID = 'weight-1'

host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'state_graph_note', tool_id: 'n1', args: { summary: 'adding weight bars and a files summary', status: 'working' } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'state_graph_note', tool_id: 'n1', result: 'ok', duration_s: 0.1 } })

// two cards on one file, one on another: weights must add, files must dedupe
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'read_file', tool_id: 'r1', args: { path: '/home/parrot/workspace/a.md' } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'read_file', tool_id: 'r1', result: 'A', duration_s: 0.4 } })
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'read_file', tool_id: 'r2', args: { path: '/home/parrot/workspace/a.md' } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'read_file', tool_id: 'r2', result: 'A', duration_s: 0.6 } })
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'patch', tool_id: 'p1', args: { path: '/home/parrot/workspace/b.md', old_string: 'x', new_string: 'y' } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'patch', tool_id: 'p1', result: 'ok', duration_s: 1.0 } })

// five more distinct names so the strip has to fold its tail
for (let i = 0; i < 5; i += 1) {
  __emit({ type: 'tool.start', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `c${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `c${i}`, result: 'ok', duration_s: 0.05 } })
}

const trail = $trails.get()[SID]
const toolKey = trail.order.find(key => trail.nodes[key]?.baseKey === 'tool:read_file')

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

await check('the node carries weight bars sharing the task seconds', () => {
  const detail = nodeDetail(trail, toolKey)

  if (!detail?.bars?.length) {
    throw new Error(`no bars: ${JSON.stringify(detail)}`)
  }

  const read = detail.bars.find(bar => bar.label === 'read_file')

  if (!read || read.seconds !== 1 || read.ops !== 2) {
    throw new Error(`read_file bar wrong: ${JSON.stringify(read)}`)
  }

  const total = detail.bars.reduce((sum, bar) => sum + bar.share, 0)

  // the data keeps the six heaviest names, so their shares cover the bulk of the
  // task and the remaining names are the ellipsis' share
  if (!(total > 0.9) || total > 1.0001) {
    throw new Error(`shares out of range for a ${detail.bars.length}-name strip: ${total}`)
  }

  if (!detail.bars.every((bar, index) => index === 0 || detail.bars[index - 1].seconds >= bar.seconds)) {
    throw new Error('bars are not sorted by seconds')
  }

  if (detail.barOps < 3 || detail.barTotal <= 0) {
    throw new Error(`summary numbers wrong: ${detail.barOps} / ${detail.barTotal}`)
  }
})

await check('files are deduped with hit counts, in first-seen order', () => {
  const detail = nodeDetail(trail, toolKey)

  if (!detail.objects || detail.objects.length !== 2) {
    throw new Error(`expected 2 paths, got ${JSON.stringify(detail.objects)}`)
  }

  if (detail.objects[0][0] !== '/home/parrot/workspace/a.md' || detail.objects[0][1] !== 2) {
    throw new Error(`first path wrong: ${JSON.stringify(detail.objects[0])}`)
  }
})

await check('the pane renders the weight strip and the files list', () => {
  $detail.set(`${SID}:${toolKey}`)
  const frame = renderFrame()

  // labels are built by string concat, so React splits them with a comment node
  if (!/weight <!-- -->\d+ ops · [\d.]+s/.test(frame) || !/files \d+/.test(frame)) {
    throw new Error(`sections missing from the pane: ${(frame.match(/weight[^<]*|files[^<]*/g) || []).slice(0, 3).join(' | ')}`)
  }

  // the weight rows sit after the session id, the files row right after pin
  const at = (re) => {
    const found = frame.search(re)

    return found
  }
  // the header's doing-text also says "weight"/"files", so anchor on the label forms
  const order = [at(/font-mono">[^<]*</), at(/weight <!-- -->/), at(/>pin</), at(/files \d/)]

  if (!(order[0] > 0 && order[1] > order[0] && order[3] > order[2] && order[2] > 0)) {
    throw new Error(`rows are out of place: ${JSON.stringify(order)}`)
  }

  if (!/width:\d+%/.test(frame)) {
    throw new Error(`no bar width painted: ${(frame.match(/width:[^";]+/g) || []).join(',')}`)
  }

  if (!frame.includes('a.md') || !frame.includes('x2')) {
    throw new Error(`file row not rendered: ${(frame.match(/a\.md|x2/g) || []).join(',')}`)
  }

  if (!/\d+ ops · \d+\.\ds/.test(frame)) {
    throw new Error(`ops counter missing: ${(frame.match(/\d+ ops · [\d.]+s/g) || []).join(',')}`)
  }
})

await check('a long strip folds its tail into an ellipsis', async () => {
  $detail.set(`${SID}:${toolKey}`)
  const frame = await renderFrame()
  const from = frame.indexOf('>weight <!-- -->')
  const strip = frame.slice(from, from + 2600)
  const bars = (strip.match(/class="flex items-center gap-1"/g) || []).length

  if (bars !== 3) {
    throw new Error(`expected 3 painted bars, got ${bars}`)
  }

  if (!/>…3</.test(strip)) {
    throw new Error(`no folded-tail marker where expected: ${strip.slice(0, 260)}`)
  }
})

check('a node with no timed cards degrades without bars', () => {
  $detail.set('')
  const detail = nodeDetail(trail, trail.order[0])

  if (!detail) {
    throw new Error('the first node should still have a payload')
  }

  if (!Array.isArray(detail.bars) && detail.bars !== null) {
    throw new Error(`bars slot is neither an array nor null: ${JSON.stringify(detail.bars)}`)
  }
})

await check('no NaN leaks into the weight numbers', () => {
  $detail.set(`${SID}:${toolKey}`)

  if (renderFrame().includes('NaN') || renderToString(jsx(GraphView, { trail })).includes('NaN')) {
    throw new Error('NaN in the weight panel')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nweight checks passed')
if (failures) {
  process.exitCode = 1
}
