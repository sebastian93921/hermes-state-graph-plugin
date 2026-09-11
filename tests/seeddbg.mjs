import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document
const { __resetHost, host } = await import('@hermes/plugin-sdk')
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
__resetHost({
  messages: [
    { role: 'user', content: 'what is the flag' },
    { role: 'tool', name: 'terminal', tool_call_id: 's1', context: 'date', args: { command: 'date' }, content: 'Fri Sep 11' },
    { role: 'assistant', content: 'The flag is HTB{42}' }
  ]
})
host.state.focusedSessionId.set('seed-dbg')
await new Promise(r => setTimeout(r, 40))
const t = $trails.get()['seed-dbg']
console.log('trail?', Boolean(t))
if (t) {
  console.log('order', JSON.stringify(t.order))
  for (const n of Object.values(t.nodes)) {
    console.log(n.baseKey, '|', n.name, '|', n.text)
  }
}
