// Freeze-the-march probe.
// 1. While busy: the hop values are phase-rotated, starting at the current frame.
// 2. The rendered rest attribute equals the first value of the hop sequence, so
//    whenever the stream goes idle the last painted frame is the resting spot.
// 3. Render is deterministic for the same stamp => a frozen frame.
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, $trails } from './plugin.js'

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'frz-1'
host.state.focusedSessionId.set(SID)
host.state.busy.set(true)

const NAMES = ['terminal', 'read_file', 'search_files', 'web_search', 'patch', 'write_file']

for (let i = 0; i < 8; i++) {
  const name = `${NAMES[i % NAMES.length]}#${Math.floor(i / NAMES.length)}`
  __emit({ type: 'tool.start', session_id: SID, payload: { name, tool_id: `t${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name, tool_id: `t${i}`, result: 'ok' } })
}

const trail = $trails.get()[SID]
const html = renderToString(jsx(GraphView, { trail }))
const hop = /sg-edge sg-edge-dot[^"]*"[^>]*stroke-dashoffset="(\d+)"/.exec(html)
const values = /attributeName="stroke-dashoffset" values="([^"]*)"/.exec(html)

console.log('status:', trail.status, '| hop rest:', hop?.[1], '| hop values:', values?.[1])

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log('ok  ', label) } catch (error) { failures += 1; console.log('FAIL', label, '->', error.message) }
}

check('the hop rests on a multiple of the 8px slot', () => {
  const rest = Number(hop?.[1] ?? NaN)
  if (!Number.isFinite(rest) || rest % 8 !== 0 || rest > 40) {
    throw new Error(`rest ${hop?.[1]}`)
  }
})
check('the hop starts where it rests and steps the full 5 slots', () => {
  const seq = (values?.[1] || '').split(';').map(Number)
  if (seq.length !== 6) {
    throw new Error(`expected 6 frames (5 steps + wrap), got ${seq.length}`)
  }
  if (seq[0] !== Number(hop?.[1])) {
    throw new Error(`first frame ${seq[0]} != resting offset ${hop?.[1]}`)
  }
  for (let i = 1; i < 5; i++) {
    if ((seq[i - 1] + 32) % 40 !== seq[i]) {
      throw new Error(`frame ${i}: ${seq[i - 1]} -> ${seq[i]} is not one 8px slot`)
    }
  }
  if (seq[5] !== seq[0]) {
    throw new Error(`the cycle must wrap to its start, got ${seq[5]}`)
  }
})
check('render is deterministic for the same stamp (frozen frame)', () => {
  const again = renderToString(jsx(GraphView, { trail: $trails.get()[SID] }))
  const rest2 = /sg-edge sg-edge-dot[^"]*"[^>]*stroke-dashoffset="(\d+)"/.exec(again)?.[1]
  if (rest2 !== hop?.[1]) {
    throw new Error(`rest drifted ${hop?.[1]} -> ${rest2}`)
  }
})
check('no NaN, and the small-dot base stays static', () => {
  if (/NaN/.test(html)) {
    throw new Error('NaN in markup')
  }
  if (!html.includes('stroke-dasharray="0.1 7" stroke-linecap="round" stroke-dashoffset="8"')) {
    throw new Error('the base dot pattern lost its static form')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nfreeze checks passed')
process.exit(failures ? 1 : 0)
