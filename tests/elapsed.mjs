// Elapsed-time probe: the active edge must carry a seconds stamp that tiers to
// m s / h m s, driven by a 200ms tick atom while the run is open.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  // node's own navigator is a getter
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollTo = function scrollTo() {}

const { renderToString } = await import('react-dom/server')
const { jsx } = await import('react/jsx-runtime')
const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
const act = req('react').act
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { GraphView, $trails, $tick, elapsedLabel, nodeElapsed } = await import('./plugin.js')

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

// tiered label, direct
check('the clock tiers roll up: s, m s, h m s', () => {
  const cases = [
    [0.8, '0.8s'],
    [12.3, '12s'],
    [61, '1m 01s'],
    [125, '2m 05s'],
    [3599, '59m 59s'],
    [3600, '1h 00m 00s'],
    [3725, '1h 02m 05s']
  ]

  for (const [value, want] of cases) {
    const got = elapsedLabel(value)
    if (got !== want) {
      throw new Error(`${value} -> ${got}, want ${want}`)
    }
  }
})

// live stream
const SID = 'elapsed-probe'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', args: { summary: 'Timing the running call', status: 'working' } }
})
__emit({
  type: 'tool.start',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 'e1', args: { command: 'sleep 2' } }
})

const running = $trails.get()[SID]
const runningHtml = renderToString(jsx(GraphView, { trail: running }))

check('the open call is stamped with a start time', () => {
  const card = running.cards.find(c => c.key === 'e1')
  if (!Number.isFinite(card?.startedAt) || !card.startedAt) {
    throw new Error(`startedAt = ${card && card.startedAt}`)
  }
})

check('the live edge paints a seconds stamp', () => {
  if (!/[0-9](\.[0-9])?s/.test(runningHtml)) {
    throw new Error(`no seconds text in ${runningHtml.slice(0, 160)}`)
  }
})

check('the live edge paints its own time node', () => {
  if (!/sg-edge-time/.test(runningHtml)) {
    throw new Error('no edge time node')
  }
})

check('every visible step card carries its own clock', () => {
  const visible = running.order.filter(k => running.nodes[k])

  if (!visible.length) {
    throw new Error('no nodes')
  }

  // nodeElapsed is defined on the trail's own stamps, no Date magic needed
  for (const key of visible) {
    const secs = nodeElapsed(running, key)

    if (!Number.isFinite(secs) || secs < 0) {
      throw new Error(`${key} -> ${secs}`)
    }
  }

  const stamped = (runningHtml.match(/class="sg-node-time"/g) || []).length

  if (!stamped) {
    throw new Error('no per-node clock in the painted graph')
  }
})

__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 'e1', result: 'done', duration_s: 2.4 }
})

const settled = $trails.get()[SID]
check('a closed call keeps its own duration', () => {
  const card = settled.cards.find(c => c.key === 'e1')
  if (card.status !== 'ok' || card.durationS !== 2.4) {
    throw new Error(`card = ${JSON.stringify(card)}`)
  }
})

// mounted: the interval must drive re-renders
const container = document.getElementById('root')
const { createRoot } = await import('react-dom/client')
const root = createRoot(container)

await act(async () => {
  root.render(jsx(GraphView, { trail: settled }))
})

check('the tick atom is a number', () => {
  if (!Number.isFinite($tick.get())) {
    throw new Error(`tick = ${$tick.get()}`)
  }
})

const before = $tick.get()
await act(async () => {
  await new Promise(r => setTimeout(r, 460))
})
const after = $tick.get()

check('the clock advances while mounted', () => {
  if (!(after > before)) {
    throw new Error(`tick ${before} -> ${after}`)
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : 'elapsed checks passed')
process.exit(failures ? 1 : 0)
