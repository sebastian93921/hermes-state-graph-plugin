// Drag-to-pan probe: a left-button drag on the canvas must move the scroller by
// the pointer delta, and releasing must end the grab.
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

const { jsx } = await import('react/jsx-runtime')
const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
const act = req('react').act || req('react-dom/test-utils').act
const { createRoot } = await import('react-dom/client')
const { __emit, host } = await import('@hermes/plugin-sdk')
const mod = await import('./plugin.js')
const { GraphView } = mod

host.request = async () => ({ messages: [] })
mod.default.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'drag-1'

host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

for (let i = 0; i < 12; i += 1) {
  __emit({ type: 'tool.start', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, result: 'ok', duration_s: 0.1 } })
}

const container = document.getElementById('root')
const root = createRoot(container)

await act(async () => {
  root.render(jsx(GraphView, { trail: mod.$trails.get()[SID] }))
})

let failures = 0

const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

const canvas = () => Array.from(container.querySelectorAll('div')).find(node => (node.getAttribute('class') || '').includes('overflow-auto') && (node.getAttribute('class') || '').includes('p-2'))
const fire = async (node, type, init) => act(async () => {
  node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, ...init }))
})

await check('the canvas is a grabbable scroll area', () => {
  const el = canvas()

  if (!el) {
    throw new Error('no canvas scroller mounted')
  }

  const style = el.getAttribute('style') || ''

  if (!/cursor:\s*grab/.test(style)) {
    throw new Error(`no grab cursor: "${style}"`)
  }
})

await check('a left-button drag pans the canvas by the pointer delta', async () => {
  const el = canvas()

  await fire(el, 'mousedown', { clientX: 300, clientY: 200 })
  await fire(el, 'mousemove', { clientX: 240, clientY: 170 })

  if (el.scrollLeft !== 60 || el.scrollTop !== 30) {
    throw new Error(`pan is ${el.scrollLeft}/${el.scrollTop}, expected 60/30`)
  }
})

await check('further drags continue from the new position and stop on release', async () => {
  const el = canvas()

  await fire(el, 'mousemove', { clientX: 200, clientY: 150 })

  if (el.scrollLeft !== 100 || el.scrollTop !== 50) {
    throw new Error(`pan is ${el.scrollLeft}/${el.scrollTop}, expected 100/50`)
  }

  await fire(el, 'mouseup', { clientX: 200, clientY: 150 })
  await fire(el, 'mousemove', { clientX: 100, clientY: 100 })

  if (el.scrollLeft !== 100 || el.scrollTop !== 50) {
    throw new Error(`the release did not stop the grab (${el.scrollLeft}/${el.scrollTop})`)
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\ndrag pan checks passed')
if (failures) {
  process.exitCode = 1
}
