// What does the mounted box element actually carry?
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollTo = function scrollTo() {}

const { jsx } = await import('react/jsx-runtime')
const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
const act = req('react').act
const { createRoot } = await import('react-dom/client')
const { __emit, host } = await import('@hermes/plugin-sdk')
const mod = await import('./plugin.js')

host.request = async () => ({ messages: [] })
mod.default.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'dd'

host.state.focusedSessionId.set(SID)
host.state.busy.set(true)
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: 't1', args: { command: 'ls -la', timeout: 90 } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: 't1', result: 'plugin.js', duration_s: 0.1 } })

const container = dom.window.document.getElementById('root')
const root = createRoot(container)

mod.$detail.set(`${SID}:${mod.$trails.get()[SID].order[0]}`)
await act(async () => {
  root.render(jsx(mod.GraphView, { trail: mod.$trails.get()[SID] }))
})

const divs = Array.from(container.querySelectorAll('div'))

console.log('n divs', divs.length)
for (const node of divs.slice(0, 6)) {
  console.log('|', JSON.stringify(node.getAttribute('style')), '|', JSON.stringify((node.getAttribute('class') || '').slice(0, 44)))
}
