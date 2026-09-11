// Interim-answer probe: each streamed answer segment — interim or final — must
// become a node whose title is its own text, never the bare `answering` tag.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { jsx } = await import('react/jsx-runtime')
const { renderToString } = await import('react-dom/server')
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { $trails, GraphView, nodeDetail, $detail } = await import('./plugin.js')

plugin.register({
  source: 'p',
  register: () => () => {},
  registerMany: () => {},
  onDispose: () => {},
  rest: async () => ({}),
  socket: () => () => {},
  os: {},
  storage: () => () => {},
  i18n: { register: () => {} }
})

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

const SID = 'interim-probe'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', args: { summary: 'Checking the interim answers', status: 'working' } }
})
__emit({ type: 'message.interim', session_id: SID, payload: { text: 'First I checked the file' } })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'completed' } })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 't1', args: { command: 'date' }, result: 'Fri', duration_s: 0.1 }
})
__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'message.delta', session_id: SID, payload: { text: 'The flag is ' } })
__emit({ type: 'message.delta', session_id: SID, payload: { text: 'HTB{42}' } })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'completed' } })

const trail = $trails.get()[SID]
const titles = Object.values(trail.nodes).map(node => node.name)

check('no node is stuck on the bare answering tag', () => {
  if (titles.includes('answering')) {
    throw new Error(`titles = ${JSON.stringify(titles)}`)
  }
})
check('the interim segment became its own titled node', () => {
  if (!titles.includes('First I checked the file')) {
    throw new Error(`titles = ${JSON.stringify(titles)}`)
  }
})
check('the final answer is one node with the joined text', () => {
  if (!titles.includes('The flag is HTB{42}')) {
    throw new Error(`titles = ${JSON.stringify(titles)}`)
  }
  const lastDone = Object.keys(trail.nodes).filter(k => trail.nodes[k].baseKey === 'done').slice(-1)[0]
  if (trail.nodes[lastDone].name !== 'The flag is HTB{42}') {
    throw new Error(`last done = ${JSON.stringify(trail.nodes[lastDone].name)}`)
  }
})
check('the interim node still sits between the note and the tool', () => {
  const order = trail.order.map(k => trail.nodes[k].baseKey)
  const iInterim = order.findIndex(k => String(k).startsWith('done'))
  const iTerm = order.indexOf('tool:terminal')

  if (!(iInterim >= 0) || !(iTerm >= 0)) {
    throw new Error(`order = ${JSON.stringify(order)}`)
  }
})
check('each answer node detail shows its own markdown text', () => {
  const doneKeys = Object.keys(trail.nodes).filter(k => trail.nodes[k].baseKey === 'done')
  for (const key of doneKeys) {
    const detail = nodeDetail(trail, key)
    const step = detail?.rows?.find(r => r.label === 'step')
    if (!step || !step.markdown) {
      throw new Error(`detail for ${key} = ${JSON.stringify(detail)}`)
    }
  }
})
check('the rendered graph carries both answer texts', () => {
  const html = renderToString(jsx(GraphView, { trail }))
  for (const needle of ['First I checked the file', 'The flag is HTB']) {
    if (!html.includes(needle)) {
      throw new Error(`missing ${needle}`)
    }
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : 'interim answer checks passed')
process.exit(failures ? 1 : 0)
