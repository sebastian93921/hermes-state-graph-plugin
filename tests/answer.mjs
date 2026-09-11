// Answer-node probe: the terminal node must carry the answer text itself, both
// while streaming (message.delta) and after a seeded history reload.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { __emit, __resetHost, host } = await import('@hermes/plugin-sdk')
const { GraphView, nodeDetail, $trails } = await import('./plugin.js')
const { jsx } = await import('react/jsx-runtime')
const { createRequire } = await import('node:module')
const require0 = createRequire(import.meta.url)
const plugin = (await import('./plugin.js')).default

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

// ── live stream path ───────────────────────────────────────────────────────
const SID = 'answer-probe'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'session.started', session_id: SID, payload: {} })
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', args: { summary: 'Answering the probe question', status: 'working' } }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 't1', args: { command: 'date' }, result: 'Fri Sep 11', duration_s: 0.1 }
})
__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'message.delta', session_id: SID, payload: { text: 'The flag is HTB{42}' } })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'completed' } })

const trail = $trails.get()[SID]
const done = Object.values(trail?.nodes || {}).find(node => node.baseKey === 'done')

check('the terminal node is named by the answer text', () => {
  if (!done) {
    throw new Error('no terminal node')
  }
  if (done.name !== 'The flag is HTB{42}') {
    throw new Error(`name = ${JSON.stringify(done.name)}`)
  }
})
check('the answer text is on the trail', () => {
  if (!String(trail.answerFull || trail.answer).includes('The flag is HTB{42}')) {
    throw new Error(`answer = ${JSON.stringify(trail.answer)}`)
  }
})
check('the node detail surfaces the answer under step', () => {
  const detail = nodeDetail(trail, done.key)
  const row = detail?.rows?.find(r => r.label === 'step')
  if (!row || !/HTB\{42\}/.test(String(row.value))) {
    throw new Error(`step row = ${JSON.stringify(row)}`)
  }
})
check('the task band still carries the agent note', () => {
  if (done.summary !== 'Answering the probe question') {
    throw new Error(`summary = ${JSON.stringify(done.summary)}`)
  }
})
check('the graph paints the answer text on the card', () => {
  const html = render(jsx(GraphView, { trail }))
  if (!html.includes('The flag is HTB')) {
    throw new Error('answer text missing from the rendered graph')
  }
})

// ── seed-from-history path ─────────────────────────────────────────────────
__resetHost({
  messages: [
    { role: 'user', content: 'what is the flag' },
    {
      role: 'tool',
      name: 'terminal',
      tool_call_id: 's1',
      context: 'date',
      args: { command: 'date' },
      content: 'Fri Sep 11'
    },
    { role: 'assistant', content: 'The flag is HTB{42}' }
  ]
})

const SID2 = 'answer-seed-2'
host.state.focusedSessionId.set(SID2)
await new Promise(resolve => setTimeout(resolve, 30))

const seeded = $trails.get()[SID2]
const seedDone = Object.values(seeded?.nodes || {}).find(node => node.baseKey === 'done')

check('a seeded history also names the terminal node with the answer', () => {
  if (!seedDone) {
    throw new Error('no seeded terminal node')
  }
  if (seedDone.name !== 'The flag is HTB{42}') {
    throw new Error(`seed name = ${JSON.stringify(seedDone.name)}`)
  }
})

function render(node) {
  const { renderToString } = require0('react-dom/server')
  return renderToString(node)
}

console.log(failures ? `\n${failures} FAILURE(S)` : 'answer node checks passed')
process.exit(failures ? 1 : 0)
