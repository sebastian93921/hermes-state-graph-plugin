// Real click test: mount the pane in a DOM, click the `… N` chip, and assert the
// lane opens (and clicks shut again). SSR can render the chip; only a mounted
// component proves the onClick actually fires.
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

// jsdom implements no scrolling; the pane's follow-effect calls scrollTo
dom.window.HTMLElement.prototype.scrollTo = function scrollTo() {}

const { jsx } = await import('react/jsx-runtime')
// React 19's ESM wrapper doesn't re-export `act`; go through CJS
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const act = require('react').act || require('react-dom/test-utils').act
const { createRoot } = await import('react-dom/client')
const { __emit, host } = await import('@hermes/plugin-sdk')
const plugin = (await import('./plugin.js')).default
const { GraphView, $trails, $expandedLanes } = await import('./plugin.js')

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'dom-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

const STEPS = 28

for (let i = 0; i < STEPS; i += 1) {
  __emit({ type: 'tool.start', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, args: { command: `echo ${i}` }, result: 'ok', duration_s: 0.1 } })
}

const trail = $trails.get()[SID]
const container = document.getElementById('root')
const root = createRoot(container)

await act(async () => {
  root.render(jsx(GraphView, { trail }))
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

const cards = () => container.querySelectorAll('.sg-node').length
const chip = () => container.querySelector('.sg-chip')
const click = async el => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

console.log('mounted cards:', cards(), '| chip:', chip()?.querySelector('text')?.textContent)

check('the pane mounts with the lane elided', () => {
  if (cards() >= STEPS) {
    throw new Error(`mounted un-elided: ${cards()} cards`)
  }

  if (!chip()) {
    throw new Error('no chip in the DOM')
  }
})

await click(chip())

const countLine = () => {
  const texts = [...(chip()?.querySelectorAll('text') || [])]
  return texts.length ? texts[texts.length - 1].textContent : ''
}

console.log('after click :', cards(), '| toggle:', countLine())
console.log('atom        :', JSON.stringify($expandedLanes.get()))

check('clicking the chip spells the hidden steps out', () => {
  if (cards() !== STEPS) {
    throw new Error(`expected ${STEPS} cards after the click, got ${cards()}`)
  }

  if (!Object.keys($expandedLanes.get()).length) {
    throw new Error('the click did not set the open state')
  }

  if (!countLine().includes('▴')) {
    throw new Error(`the chip did not become the collapse toggle: "${countLine()}"`)
  }

  const top = [...(chip()?.querySelectorAll('text') || [])][0]?.textContent || ''

  if (!top.startsWith('click to collapse')) {
    throw new Error(`first line is not the collapse sentence: "${top}"`)
  }
})

await click(chip())

console.log('after close :', cards(), '| atom:', JSON.stringify($expandedLanes.get()))

check('clicking the toggle closes it again', () => {
  if (cards() >= STEPS) {
    throw new Error(`still open: ${cards()} cards`)
  }

  if (Object.keys($expandedLanes.get()).length) {
    throw new Error('the close click left the state set')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\ndom click checks passed')
process.exit(failures ? 1 : 0)
