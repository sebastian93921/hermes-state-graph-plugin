// The same-state refresh must keep a long-running node's clock advancing, and a
// finished node must keep the seconds it held (no snap back to 0s).
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { renderToString } = await import('react-dom/server')
const { jsx } = await import('react/jsx-runtime')
const { __emit, host } = await import('@hermes/plugin-sdk')
const m = await import('./plugin.js')

m.default.register({
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

const SID = 'clock-probe'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', args: { summary: 'Watching the thinking clock', status: 'working' } }
})
__emit({ type: 'thinking.delta', session_id: SID, payload: { text: 'a' } })

const first = $trail()
const thinkKey = first.order.find(k => first.nodes[k].kind === 'state' && first.nodes[k].baseKey === 'thinking')
const firstStamp = Math.round(first.nodes[thinkKey].lastAt - first.nodes[thinkKey].firstAt)

await new Promise(r => setTimeout(r, 450))
__emit({ type: 'thinking.delta', session_id: SID, payload: { text: 'b' } })

const grown = $trail()
const grownStamp = Math.round(grown.nodes[thinkKey].lastAt - grown.nodes[thinkKey].firstAt)

check('the open thinking node keeps accumulating seconds', () => {
  if (!(grownStamp >= 300)) {
    throw new Error(`stamp = ${firstStamp} -> ${grownStamp} ms`)
  }
})

check('its clock label is not the zero frame', () => {
  const html = renderToString(jsx(m.GraphView, { trail: grown }))
  const times = (html.match(/class="sg-node-time"[^>]*>([^<]*)</g) || []).map(x => x.replace(/.*>/, '').replace(/<.*$/, ''))

  if (!times.some(t => /^[0-9]/.test(t) && t !== '0s' && t !== '0.0s')) {
    throw new Error(`times = ${JSON.stringify(times)}`)
  }
})

// finish the turn: the closed node must freeze at the seconds it held
__emit({ type: 'message.delta', session_id: SID, payload: { text: 'The clock holds its value' } })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'ok' } })

await new Promise(r => setTimeout(r, 40))
host.state.busy.set(false)

const closed = $trail()
const held = Math.round(closed.nodes[thinkKey].lastAt - closed.nodes[thinkKey].firstAt)

check('a finished thinking node keeps the seconds it held', () => {
  if (Math.abs(m.nodeElapsed(closed, thinkKey) * 1000 - held) > 1) {
    throw new Error(`held=${held} now=${m.nodeElapsed(closed, thinkKey)}`)
  }

  const later = m.nodeElapsed(closed, thinkKey)

  setTimeout(() => {
    if (m.nodeElapsed($trail(), thinkKey) !== later) {
      console.log('FAIL the closed clock moved after the turn')
    }
  }, 50)
})

function $trail() {
  return m.$trails.get()[SID]
}

console.log(failures ? `\n${failures} FAILURE(S)` : 'clock checks passed')
process.exit(failures ? 1 : 0)
