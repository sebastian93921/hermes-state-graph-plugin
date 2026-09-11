// Real interaction test in a mounted DOM: a node click opens the side box, the
// [x] button closes it, and a click on the empty canvas area closes it too.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })

globalThis.window = dom.window
globalThis.document = dom.window.document
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  // node's own navigator is a getter; React only reads userAgent
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollTo = function scrollTo() {}

const { jsx } = await import('react/jsx-runtime')
// React 19's ESM wrapper doesn't re-export `act`; go through CJS
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const act = require('react').act || require('react-dom/test-utils').act
const { createRoot } = await import('react-dom/client')
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { GraphView, $trails, $detail } = await import('./plugin.js')

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: () => () => {}, i18n: { register: () => {} } })

const SID = 'dom-detail'

host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: 't1', args: { command: 'ls -la', timeout: 90 } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: 't1', result: 'plugin.js', duration_s: 0.1 } })

const trail = $trails.get()[SID]
const container = document.getElementById('root')
const root = createRoot(container)

await act(async () => {
  root.render(jsx(GraphView, { trail }))
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

const byText = text =>
  Array.from(container.querySelectorAll('*')).filter(
    node => Array.from(node.childNodes).some(part => part.nodeType === 3 && String(part.nodeValue).trim() === text) && node !== container
  )
const click = async node => {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
// each hit rect carries a <title> with the card's own text -> pick by that
const hitFor = title =>
  Array.from(container.querySelectorAll('rect.sg-hit')).find(rect =>
    Array.from(rect.children).some(child => child.textContent === title)
  )
const boxEl = () => Array.from(container.querySelectorAll('div')).find(node =>
  (node.getAttribute('style') || node.style?.cssText || '').replace(/\s+/g, '').includes('width:40%')
)

await check('the box is closed before any click', () => {
  if ($detail.get() !== '') {
    throw new Error(`atom holds ${$detail.get()}`)
  }

  if (byText('[x]').length) {
    throw new Error('the close button rendered with no selection')
  }
})

await check('clicking the tool node opens the side box with its payload', async () => {
  const hit = hitFor('ran ls -la')

  if (!hit) {
    throw new Error('no hit rect titled "ran ls -la"')
  }

  await click(hit)

  if (!$detail.get().startsWith(`${SID}:`)) {
    throw new Error(`atom after click: "${$detail.get()}"`)
  }

  if (!byText('[x]').length) {
    throw new Error('no close button rendered')
  }

  for (const label of ['command', 'other args', 'result', 'status', 'took']) {
    if (!byText(label).length) {
      throw new Error(`missing row label ${label}`)
    }
  }

  const box = boxEl()

  if (!box || !box.textContent.includes('ls -la') || !box.textContent.includes('plugin.js')) {
    throw new Error(`box body: ${box && box.textContent.slice(0, 200)}`)
  }
})

await check('the box sits beside the graph (row layout)', () => {
  const wrap = container.querySelector('div')

  if (!wrap) {
    throw new Error('no wrapper div')
  }

  const cls = wrap.getAttribute('class') || ''

  if (!cls.includes('flex-row')) {
    throw new Error(`wrapper is not a row: "${cls}"`)
  }

  const style = (boxEl().getAttribute('style') || boxEl().style?.cssText || '').replace(/\s+/g, '')

  if (!/width:40%/.test(style) || !/max-width:420px/.test(style)) {
    throw new Error(`the box is not a bounded side column: "${style}"`)
  }

  if (!/max-height:55%/.test(style) || !/overflow:auto/.test(style)) {
    throw new Error('the box must cap its height and scroll inside it')
  }
})

await check('the [x] button hides the box', async () => {
  const [button] = byText('[x]')

  await click(button)

  if ($detail.get() !== '') {
    throw new Error(`atom still "${$detail.get()}"`)
  }

  if (boxEl()) {
    throw new Error('the box is still mounted')
  }
})

await check('a click on the empty canvas area dismisses an open box', async () => {
  await click(hitFor('ran ls -la'))

  if (!$detail.get()) {
    throw new Error('the node click did not open the box')
  }

  await click(container.querySelector('svg').parentElement)

  if ($detail.get() !== '') {
    throw new Error(`backdrop click left "${$detail.get()}"`)
  }
})

await check('a click inside the box does not dismiss it', async () => {
  await click(hitFor('ran ls -la'))

  const open = $detail.get()

  if (!open) {
    throw new Error('the box never opened')
  }

  await click(boxEl())

  if ($detail.get() !== open) {
    throw new Error(`inner click closed it (${open} -> "${$detail.get()}")`)
  }

  await click(byText('[x]')[0])
})

await check('selecting another node swaps the panel content', async () => {
  await click(hitFor('answering'))

  const first = $detail.get()

  if (!/answering/.test(first)) {
    throw new Error(`expected the answering node, got "${first}"`)
  }

  if (byText('other args').length) {
    throw new Error('the state node should not carry a tool card row')
  }

  await click(hitFor('ran ls -la'))

  if ($detail.get() === first) {
    throw new Error('the panel did not switch nodes')
  }

  await click(byText('[x]')[0])
})

console.log(failures ? `${failures} FAILURE(S)` : 'detail dom checks passed')
process.exitCode = failures ? 1 : 0
