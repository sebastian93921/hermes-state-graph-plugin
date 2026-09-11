// Detail rendering for the answer node: a single STEP row whose value is the
// full answer text, laid out as markdown (headings, lists, inline code).
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { renderToString } = await import('react-dom/server')
const { jsx } = await import('react/jsx-runtime')
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { $trails, nodeDetail } = await import('./plugin.js')

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

const SID = 'md-answer'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', args: { summary: 'Explaining the result', status: 'working' } }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 't1', args: { command: 'date' }, result: 'x', duration_s: 0.2 }
})
__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'message.delta', session_id: SID, payload: { text: '## Flags\n- first is `HTB{1}`\n- second **bold**' } })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'completed' } })

const trail = $trails.get()[SID]
const doneKey = Object.keys(trail.nodes).find(k => trail.nodes[k].baseKey === 'done')
const detail = nodeDetail(trail, doneKey)

check('the answer detail has exactly one row, labelled step', () => {
  if (!detail || detail.rows.length !== 1) {
    throw new Error(`rows = ${JSON.stringify(detail?.rows)}`)
  }
  if (detail.rows[0].label !== 'step' || detail.rows[0].markdown !== true) {
    throw new Error(`row = ${JSON.stringify(detail.rows[0])}`)
  }
})

check('the step row carries the full markdown source', () => {
  if (detail.rows[0].value !== '## Flags\n- first is `HTB{1}`\n- second **bold**') {
    throw new Error(`value = ${JSON.stringify(detail.rows[0].value)}`)
  }
})

check('no command/result/status rows leak into the answer detail', () => {
  const labels = detail.rows.map(r => r.label)
  for (const junk of ['task', 'command', 'result', 'status', 'took']) {
    if (labels.includes(junk)) {
      throw new Error(`unexpected ${junk}`)
    }
  }
})

const html = renderToString(jsx(() => null, {}) && null) // placeholder, replaced below
const { GraphView } = await import('./plugin.js')
const { $detail } = await import('./plugin.js')
$detail.set(`${SID}:${doneKey}`)
const paneHtml = renderToString(jsx(GraphView, { trail }))

check('the rendered box shows the markdown pieces', () => {
  for (const needle of ['Flags', 'HTB{1}', 'bold', '•']) {
    if (!paneHtml.includes(needle)) {
      throw new Error(`missing ${needle}`)
    }
  }
})

check('the heading is bold and the list uses bullet markers', () => {
  if (!/font-weight:700/.test(paneHtml.replace(/\s+/g, ' '))) {
    throw new Error('no bold heading style')
  }
})

void html
console.log(failures ? `\n${failures} FAILURE(S)` : 'markdown answer detail checks passed')
process.exit(failures ? 1 : 0)
