import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { $trails } = await import('./plugin.js')
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
host.state.focusedSessionId.set('ap')
host.state.busy.set(true)
__emit({ type: 'session.started', session_id: 'ap', payload: {} })
__emit({ type: 'tool.complete', session_id: 'ap', payload: { name: 'state_graph_note', args: { summary: 'Answering the probe question', status: 'working' } } })
__emit({ type: 'message.start', session_id: 'ap', payload: {} })
__emit({ type: 'message.delta', session_id: 'ap', payload: { text: 'The flag is HTB{42}' } })
__emit({ type: 'message.complete', session_id: 'ap', payload: { status: 'completed' } })
const t = $trails.get()['ap']
console.log('trail?', Boolean(t))
if (t) {
  console.log('answer =', t.answer)
  for (const n of Object.values(t.nodes)) {
    console.log(n.baseKey, '|', n.name, '|', n.summary)
  }
}
