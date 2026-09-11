// React #310 guard: the same mounted root must survive empty -> populated
// without the hook count changing.
import { JSDOM } from 'jsdom'

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

const SID = 'hooks'

host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

const container = dom.window.document.getElementById('root')
const root = createRoot(container)
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

const empty = { sid: SID, order: [], nodes: {}, edges: {}, cards: [], current: '', previous: '', status: 'running', endedAt: 0 }

await check('empty trail renders the empty state', async () => {
  await act(async () => {
    root.render(jsx(mod.GraphView, { trail: empty }))
  })

  if (!container.textContent.includes('No agent work yet')) {
    throw new Error(`empty state missing: "${container.textContent.slice(0, 80)}"`)
  }
})

__emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: 't1', args: { command: 'ls -la', timeout: 90 } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: 't1', result: 'plugin.js', duration_s: 0.1 } })

await check('the same root re-renders populated with no hook-count error', async () => {
  await act(async () => {
    root.render(jsx(mod.GraphView, { trail: mod.$trails.get()[SID] }))
  })

  if (!container.querySelector('svg')) {
    throw new Error('the svg did not appear')
  }

  const hits = container.querySelectorAll('rect.sg-hit').length

  if (hits < 1) {
    throw new Error('no hit rects in the populated render')
  }
})

await check('a detail click works after the empty -> populated switch', async () => {
  const hit = container.querySelector('rect.sg-hit')

  await act(async () => {
    hit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  if (!$detailOk()) {
    throw new Error(`detail atom stayed empty: "${mod.$detail.get()}"`)
  }

  await act(async () => {
    root.render(jsx(mod.GraphView, { trail: mod.$trails.get()[SID] }))
  })

  if (!container.textContent.includes('[x]')) {
    throw new Error('the close button is missing after the swap')
  }
})

await check('back to an empty trail keeps the hook count stable', async () => {
  await act(async () => {
    root.render(jsx(mod.GraphView, { trail: empty }))
  })

  if (!container.textContent.includes('No agent work yet')) {
    throw new Error('empty state did not return')
  }
})

function $detailOk() {
  return String(mod.$detail.get() || '').startsWith(`${SID}:`)
}

if (failures) {
  console.log(`${failures} FAILURE(S)`)
  process.exitCode = 1
} else {
  console.log('hook-stability checks passed')
}
