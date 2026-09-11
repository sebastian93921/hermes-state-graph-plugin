// Fit probe at the tighter constants: do the two-line wraps still sit inside the
// 148x38 card, and is the widest label reasonable?
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'

const sdk = await import('@hermes/plugin-sdk')
const mod = await import('./plugin.js')
const { GraphView, layoutGraph, $trails } = mod
const { host } = sdk

host.request = async () => ({ messages: [] })
mod.default.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'fit-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

sdk.__emit({ type: 'tool.start', session_id: SID, payload: { name: 'state_graph_note', tool_id: 'n1', args: { summary: 'tightening the node geometry so more of the run fits on screen' } } })
sdk.__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'state_graph_note', tool_id: 'n1', result: '{"ok":true}' } })

const longest = 'python3 -c "print(1)" --fast --no-header-cache'

for (let i = 0; i < 12; i += 1) {
  sdk.__emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: `t${i}`, args: { command: i === 0 ? longest : `echo ${i}` } } })
  sdk.__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: `t${i}`, result: 'ok' } })
}

const trail = $trails.get()[SID]
const html = renderToString(jsx(GraphView, { trail }))
const layout = layoutGraph(trail)

// Every drawn line must fit its 148-wide card at 10px: measure with the same
// wrap the renderer used (maxChars = floor(148 / 6.4) = 23).
const lines = []
const pattern = /class="sg-activity"[^>]*>([^<]*)/g
let found = null

while ((found = pattern.exec(html))) {
  lines.push(found[1])
}
const widest = lines.reduce((max, line) => Math.max(max, line.length), 0)
const perCard = new Map()

for (const step of trail.order) {
  const node = trail.nodes[step]
  if (node) {
    perCard.set(node.key, node.name)
  }
}

let over = 0

for (const name of perCard.values()) {
  if (name.length > 46) {
    over += 1 // 2 lines x 23 chars
  }
}

console.log('card w x h:', 148, 'x', 38, '| wrap chars:', Math.floor(148 / 6.4))
console.log('cards drawn:', perCard.size, '| longest line in markup:', widest)
console.log('titles needing all of the 2-line budget:', over)
console.log('canvas:', layout.width, 'x', layout.height, '| NaN:', /NaN/.test(html) ? 'YES' : 'no')
console.log('sample:', lines.slice(0, 3).join(' // '))

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log('ok  ', label) } catch (error) { failures += 1; console.log('FAIL', label, '->', error.message) }
}

check('the widest drawn line fits the tighter card', () => {
  if (widest > 23) {
    throw new Error(`line of ${widest} chars overflows a 148px card at 23 chars/line`)
  }
})
check('a 2-line card still fits the 38px height', () => {
  // 2 baselines at 12px pitch inside 38px, centred: last baseline must stay <= h-4
  const firstBaseline = 38 / 2 - (2 - 1) * 6 + 3.5
  const last = firstBaseline + 12

  if (last > 38 - 3) {
    throw new Error(`second baseline ${last} exceeds the card`)
  }
})
check('no NaN in the tighter geometry', () => {
  if (/NaN/.test(html)) {
    throw new Error('NaN in markup')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nfit checks passed')
process.exit(failures ? 1 : 0)
