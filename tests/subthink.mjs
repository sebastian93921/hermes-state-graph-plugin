// Subagent thinking frames must read `thinking` in the worker's lane, not repeat
// the delegation goal; spawn/start/progress keep the `delegated: …` marker.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { renderToString } = await import('react-dom/server')
const { jsx } = await import('react/jsx-runtime')
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { GraphView, $trails } = await import('./plugin.js')

const disposers = []
plugin.register({
  source: 'p',
  register: () => () => {},
  registerMany: () => {},
  onDispose: fn => disposers.push(fn),
  rest: async () => ({}),
  socket: () => () => {},
  os: {},
  storage: { get: async () => null, set: async () => {} },
  i18n: { register: () => {} }
})

const SID = 'sub-thinking'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'state_graph_note', args: { summary: 'Spawning reviewers' } } })
__emit({
  type: 'subagent.spawn_requested',
  session_id: SID,
  payload: { subagent_id: 'W1', goal: 'Review the connector geometry' }
})
__emit({ type: 'subagent.thinking', session_id: SID, payload: { subagent_id: 'W1', goal: 'Review the connector geometry' } })
__emit({ type: 'subagent.progress', session_id: SID, payload: { subagent_id: 'W1', goal: 'Review the connector geometry' } })
__emit({ type: 'subagent.thinking', session_id: SID, payload: { subagent_id: 'W1', goal: 'Review the connector geometry' } })

const trail = $trails.get()[SID]
const nodes = Object.values(trail.nodes)
const w1 = trail.order.filter(key => key.includes('|W1|')).map(key => trail.nodes[key])

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

const names = w1.map(node => node.name)
const html = renderToString(jsx(GraphView, { trail }))

check('the worker lane holds thinking steps of its own', () => {
  const thinks = w1.filter(node => node.baseKey === 'thinking')
  if (thinks.length < 1) {
    throw new Error(`no thinking step: ${JSON.stringify(names)}`)
  }
  if (thinks.some(node => node.name !== 'thinking')) {
    throw new Error(`wrong title: ${JSON.stringify(thinks.map(n => n.name))}`)
  }
})

check('the delegation marker still names the goal', () => {
  const marker = w1.find(node => node.baseKey === 'subagent')
  if (!marker || !/^delegated: /.test(marker.name)) {
    throw new Error(`marker = ${marker && marker.name}`)
  }
})

check('no worker node repeats the goal as a thinking title', () => {
  const bad = w1.filter(node => node.baseKey === 'thinking' && /delegated:/.test(node.name))
  if (bad.length) {
    throw new Error(JSON.stringify(bad.map(n => n.name)))
  }
})

check('the diagram carries the thinking label in the worker row', () => {
  if (!html.includes('thinking')) {
    throw new Error('thinking text missing from the render')
  }
})

disposers.forEach(fn => fn())
console.log(failures ? `\n${failures} FAILURE(S)` : 'subagent thinking checks passed')
process.exit(failures ? 1 : 0)