// Click-the-ellipsis probe: `… N` must be a real button. Collapsed, the lane
// draws LANE_MAX_CELLS cards and one chip; after the chip is clicked, every
// step the lane hid is spelled out and the chip becomes the collapse toggle.
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, layoutGraph, $trails, $expandedLanes } from './plugin.js'

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'click-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

const STEPS = 28

for (let i = 0; i < STEPS; i += 1) {
  // distinct names: repeats of one tool collapse into a single node with a count
  __emit({ type: 'tool.start', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: `cmd_${i}`, tool_id: `t${i}`, args: { command: `echo ${i}` }, result: 'ok', duration_s: 0.1 } })
}

const trail = $trails.get()[SID]
const render = () => renderToString(jsx(GraphView, { trail }))

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

const count = (html, klass) => (html.match(new RegExp(`class="${klass}"`, 'g')) || []).length
const collapsed = render()
const collapsedLayout = layoutGraph(trail)
const taskId = collapsedLayout.tasks[0]?.id

console.log('task id:', taskId, '| steps:', trail.order.length)
console.log('collapsed: step cards', count(collapsed, 'sg-node'), '| chip rects', count(collapsed, 'sg-gap'), '| width', collapsedLayout.width)
console.log('chip label:', (collapsed.match(/class="sg-gap-label"[^>]*>([^<]*)</) || [])[1])

check('collapsed: the lane is elided and the chip says what it hides', () => {
  if (count(collapsed, 'sg-node') >= STEPS) {
    throw new Error('lane was not elided')
  }

  const label = (collapsed.match(/class="sg-gap-label"[^>]*>([^<]*)</) || [])[1] || ''

  if (!/…\s*\d+/.test(label)) {
    throw new Error(`chip label is not an ellipsis count: "${label}"`)
  }
})

check('the chip is a button with a hint, not a dead label', () => {
  // the <g> carries `sg-chip` plus a role class; the rect is classed exactly
  if (count(collapsed, 'sg-gap') !== 1 || !/class="sg-chip sg-gap"/.test(collapsed)) {
    throw new Error(`expected one clickable chip, found ${count(collapsed, 'sg-gap')} rects`)
  }

  if (!/click to show all \d+ hidden steps/.test(collapsed)) {
    throw new Error('no "click to show all" hint in the markup')
  }

  if (!/style="cursor:pointer"/.test(collapsed)) {
    throw new Error('chip is not marked clickable')
  }
})

// click it: this is the state the component flips on click
$expandedLanes.set({ [`${SID}:${taskId}|main`]: true })
const opened = render()
const openedLayout = layoutGraph(trail, new Set([`${taskId}|main`]))

console.log('opened   : step cards', count(opened, 'sg-node'), '| chip rects', count(opened, 'sg-collapse'), '| width', openedLayout.width)
console.log('toggle   :', (opened.match(/class="sg-collapse-label"[^>]*>([^<]*)</) || [])[1])

check('clicked open: every hidden step is spelled out', () => {
  const drawn = count(opened, 'sg-node')

  if (drawn !== STEPS) {
    throw new Error(`expected all ${STEPS} step cards, drew ${drawn}`)
  }

  if (openedLayout.tasks[0]?.lanes?.[0]?.forkCol === undefined) {
    throw new Error('lanes missing from the layout')
  }

  if (openedLayout.tasks[0].lanes[0].cells.some(cell => cell.type === 'gap')) {
    throw new Error('the gap cell survived the expansion')
  }
})

check('the toggle moves to the end of the lane and closes it again', () => {
  if (count(opened, 'sg-collapse') < 1) {
    throw new Error('no collapse toggle while open')
  }

  const cells = openedLayout.tasks[0].lanes[0].cells

  if (cells[cells.length - 1]?.type !== 'collapse') {
    throw new Error(`collapse toggle is not the last cell (${cells[cells.length - 1]?.type})`)
  }

  if (!/collapse the \d+ steps/.test(opened)) {
    throw new Error('no collapse hint in the markup')
  }

  // every step now has geometry
  const placed = trail.order.filter(key => openedLayout.positions[key])

  if (placed.length !== STEPS) {
    throw new Error(`${placed.length} of ${STEPS} steps have positions`)
  }
})

check('clicking the collapse toggle puts the ellipsis back', () => {
  $expandedLanes.set({})
  const again = render()

  if (count(again, 'sg-gap') < 1 || count(again, 'sg-node') !== count(collapsed, 'sg-node')) {
    throw new Error('the lane did not return to its elided shape')
  }
})

check('neither state emits NaN', () => {
  if (/NaN/.test(collapsed) || /NaN/.test(opened)) {
    throw new Error('NaN in markup')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nclick checks passed')
process.exit(failures ? 1 : 0)
