// Detail-panel probe: every step card is a hit target, and clicking one opens
// the payload rows (agent summary + the matching tool card's command/result).
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, nodeDetail, $trails, $detail } from './plugin.js'

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'detail-1'

host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'thinking.delta', session_id: SID, payload: { text: 'planning' } })
__emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: 't1', args: { command: 'echo hello', timeout: 120 } } })
__emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: 't1', result: 'hello', duration_s: 0.2 } })

const trail = $trails.get()[SID]
const html = renderToString(jsx(GraphView, { trail }))

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
const has = (needle) => html.includes(needle)
const stepKeys = () => trail.order.filter(key => trail.nodes[key] && trail.nodes[key].kind !== undefined)

check('every step card has a hit rect', () => {
  const hits = (html.match(/class="sg-hit"/g) || []).length
  const steps = stepKeys().length

  if (hits !== steps) {
    throw new Error(`hit rects ${hits} != step nodes ${steps}`)
  }
})

check('the hit rects are clickable + pointed', () => {
  // the transparent fill keeps the rect paintable so svg hits register, and the
  // cursor style is what the user sees under the mouse.
  if (!has('style="cursor:pointer"')) {
    throw new Error('hit rect lost the pointer cursor')
  }

  if (!has('fill="transparent"')) {
    throw new Error('hit rect must carry a transparent paint so it stays hit-testable')
  }
})

check('a tool node resolves to its command, arg, and result', () => {
  const toolKey = trail.order.find(key => trail.nodes[key]?.baseKey === 'tool:terminal')

  if (!toolKey) {
    throw new Error('no tool node in the trail')
  }

  const detail = nodeDetail(trail, toolKey)
  const flat = detail.rows.map(row => `${row.label}=${row.value}`).join(' | ')

  for (const needle of ['command=echo hello', 'timeout 120', 'result=hello', 'status=ok', 'took=']) {
    if (!flat.includes(needle)) {
      throw new Error(`missing "${needle}" in [${flat}]`)
    }
  }

  if (/\b120\b.*\bcommand\b/.test(flat.replace('timeout 120', ''))) {
    throw new Error('timeout leaked into the command row')
  }
})

check('the timeout is demoted to the other-args row', () => {
  const toolKey = trail.order.find(key => trail.nodes[key]?.baseKey === 'tool:terminal')
  const detail = nodeDetail(trail, toolKey)
  const other = detail.rows.find(row => row.label === 'other args')

  if (!other || !other.value.includes('timeout')) {
    throw new Error(`other-args row wrong: ${JSON.stringify(other)}`)
  }

  if (other.value.includes('\n')) {
    throw new Error('other args should sit on one compact line')
  }
})

check('a thinking node reports the step with no invented payload', () => {
  const thinkKey = trail.order.find(key => trail.nodes[key]?.baseKey === 'thinking')

  if (!thinkKey) {
    throw new Error('no thinking node')
  }

  const detail = nodeDetail(trail, thinkKey)

  if (!detail || detail.rows.length === 0) {
    throw new Error('thinking node produced no rows')
  }

  if (JSON.stringify(detail).includes('null')) {
    throw new Error('empty fields leaked into the rows')
  }

  const flat = detail.rows.map(row => `${row.label}=${row.value}`).join(' | ')

  if (!/step=thinking/.test(flat)) {
    throw new Error(`thinking row missing: ${flat}`)
  }
})

check('clicking sets the open node and the panel renders its rows', () => {
  const toolKey = trail.order.find(key => trail.nodes[key]?.baseKey === 'tool:terminal')

  $detail.set(`${SID}:${toolKey}`)
  const withPanel = renderToString(jsx(GraphView, { trail }))

  for (const needle of ['echo hello', 'command', 'result', 'hello']) {
    if (!withPanel.includes(needle)) {
      throw new Error(`panel missing "${needle}"`)
    }
  }

  if (!/step \d+\/\d+/.test(withPanel)) {
    throw new Error('no step ordinal in the panel header')
  }
})

check('the panel is scoped to its own session', () => {
  $detail.set(`other:${trail.order[0]}`)
  const other = renderToString(jsx(GraphView, { trail }))

  if (!other.includes('class="sg-node"')) {
    throw new Error('graph dropped')
  }

  if (other.includes('COMMAND') || other.includes('>command<')) {
    throw new Error('a foreign session leaked its panel')
  }
})

// open the panel first: the stub prints `label:textLength`, so the two lengths
// prove the command and the result are separate clipboard payloads
$detail.set(`${SID}:${trail.order.find(key => trail.nodes[key]?.baseKey === 'tool:terminal')}`)

check('the command and result rows each get their own icon-only Copy button', () => {
  const frame = renderToString(jsx(GraphView, { trail }))
  const buttons = (frame.match(/data-stub="CopyButton"[^<]*</g) || []).join(',')

  // "echo hello" is 10 chars, the result "hello" is 5
  if (!/data-appearance="icon"[^>]*>Copy command:10</.test(frame)) {
    throw new Error(`no icon-only command copy button (${buttons})`)
  }

  if (!/data-appearance="icon"[^>]*>Copy result:5</.test(frame)) {
    throw new Error(`no icon-only result copy button (${buttons})`)
  }
})

check('the detail box is capped at 100% height', () => {
  const frame = renderToString(jsx(GraphView, { trail }))

  if (!/max-height:100%/.test(frame)) {
    throw new Error('the box height is not 80% of the pane')
  }
})

check('the other rows stay plain (no stray copy buttons)', () => {
  const frame = renderToString(jsx(GraphView, { trail }))
  const count = (frame.match(/data-stub="CopyButton"/g) || []).length

  if (count !== 2) {
    throw new Error(`expected exactly two copy buttons, got ${count}`)
  }
})

check('no NaN in the detail panel', () => {
  $detail.set(`${SID}:${trail.order[0]}`)

  if (renderToString(jsx(GraphView, { trail })).includes('NaN')) {
    throw new Error('NaN in panel')
  }
})

console.log(failures ? `${failures} FAILURE(S)` : 'detail checks passed')
process.exitCode = failures ? 1 : 0
