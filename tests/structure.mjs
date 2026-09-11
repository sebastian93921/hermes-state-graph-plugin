// Structural elision probe. The lane must read
//     [a] -> …… -> [h] -> …… -> [z]
//                    +-> [c1] -> …… -> [h1]
//                    +-> [c2] -> …… -> [h2]
// i.e. two chips around the fork node, the fork node itself visible, and the
// branches hanging off THAT node — not off a chip, and not off the band header.
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, layoutGraph, $trails, $expandedLanes } from './plugin.js'

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'struct-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

const step = (name, args = {}) => {
  __emit({ type: 'tool.start', session_id: SID, payload: { name, tool_id: name, args } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name, tool_id: name, args, result: 'ok', duration_s: 0.1 } })
}
const branch = (sid, goal, name) => {
  __emit({ type: 'subagent.spawn_requested', session_id: SID, payload: { subagent_id: sid, goal, task_index: 0 } })
  __emit({ type: 'subagent.tool', session_id: SID, payload: { subagent_id: sid, goal, tool_name: name, tool_preview: name } })
}

const MAIN_HEAD = 8
const MAIN_TAIL = 8
const BRANCH_STEPS = 7

// [a] .. [h]: the work leading up to the fan-out (h = the fork node, main[19])
for (let i = 0; i < MAIN_HEAD - 1; i += 1) {
  step(`lead_${i}`)
}

step('delegate_task', { tasks: ['branch A', 'branch B'] })

// the moment both branches start
branch('sub-A', 'branch A', 'a_0')
branch('sub-B', 'branch B', 'b_0')

// the main lane carries on while they run
for (let i = 0; i < MAIN_TAIL; i += 1) {
  step(`tail_${i}`)
}

// the branches keep working
for (let i = 1; i < BRANCH_STEPS; i += 1) {
  branch('sub-A', 'branch A', `a_${i}`)
  branch('sub-B', 'branch B', `b_${i}`)
}

__emit({ type: 'subagent.complete', session_id: SID, payload: { subagent_id: 'sub-A', goal: 'branch A', status: 'completed', summary: 'done' } })

const trail = $trails.get()[SID]
const html = renderToString(jsx(GraphView, { trail }))
const layout = layoutGraph(trail)
console.log('TASKS:', layout.tasks.map(t => `${t.id}(${t.text ? 'titled' : 'untitled'}):[${(t.lanes || []).map(l => `${l.id}=${l.steps.length}`).join(' ')}]`).join('  |  '))
const task = layout.tasks.reduce((best, t) => ((t.lanes || []).reduce((n, l) => n + l.steps.length, 0) > (best ? best.lanes.reduce((n, l) => n + l.steps.length, 0) : -1) ? t : best), null)
console.log('band picked:', task.id, '| steps in it:', task.lanes.reduce((n, l) => n + l.steps.length, 0))
const lanes = Object.fromEntries(task.lanes.map(lane => [lane.id, lane]))
const main = lanes.main
const chips = main.cells.filter(cell => cell.type === 'gap')
const fork = layout.positions[trail.order.find(key => key.includes('delegate_task'))]
// node keys carry a `~seq` suffix, so read the heads off the lanes themselves
const a0 = layout.positions[lanes['sub-A'].steps[0].key]
const b0 = layout.positions[lanes['sub-B'].steps[0].key]
const elbows = [...html.matchAll(/d="(M [^"]*)"[^>]*(?:class="sg-edge sg-edge-fork")?/g)].map(m => m[1]).filter(d => /H [\d.-]+ V [\d.-]+ H/.test(d))

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

const show = lane => lane.cells.map(cell => (cell.type === 'gap' ? `…… ${cell.hidden}` : cell.step.key.replace(/^.*~/, ''))).join(' -> ')

console.log('main  :', show(main))
console.log('sub-A :', show(lanes['sub-A']))
console.log('sub-B :', show(lanes['sub-B']))
console.log('fork node:', JSON.stringify(fork), '| a_0:', JSON.stringify(a0), '| b_0:', JSON.stringify(b0))
console.log('elbows:', elbows.join(' || '))
console.log('drawn steps:', (html.match(/class="sg-node"/g) || []).length, '| chips:', (html.match(/class="sg-gap"/g) || []).length)

check('the middle of the main lane collapses into TWO chips around the fork node', () => {
  if (chips.length !== 2) {
    throw new Error(`expected 2 chips in the main lane, found ${chips.length}`)
  }

  const forkCell = main.cells.findIndex(cell => cell.type === 'step' && cell.step.key.includes('delegate_task'))

  if (forkCell < 0) {
    throw new Error('the fork node is not drawn as a step')
  }

  if (!(forkCell > 0 && forkCell < main.cells.length - 1)) {
    throw new Error(`the fork node is at the lane's edge (index ${forkCell}/${main.cells.length})`)
  }

  if (main.cells[0].type !== 'step' || main.cells[main.cells.length - 1].type !== 'step') {
    throw new Error('the lane does not start and end on a step')
  }
})

check('the fork node is on screen, and the branch hangs off IT', () => {
  if (!fork) {
    throw new Error('the fork node has no position')
  }

  if (!a0 || !b0) {
    throw new Error('a branch head has no position')
  }

  if (a0.x !== b0.x || a0.y === b0.y) {
    throw new Error(`branches are not side by side: a=${JSON.stringify(a0)} b=${JSON.stringify(b0)}`)
  }

  if (!(a0.x > fork.x)) {
    throw new Error(`branches start at ${a0.x}, not right of the fork node ${fork.x}`)
  }

  const elbowsHere = elbows.filter(d => Number(d.match(/^M ([\d.-]+)/)[1]) === fork.x + 148)

  if (elbowsHere.length !== 2) {
    throw new Error(`expected 2 elbows leaving the fork node, found ${elbowsHere.length}`)
  }
})

check('each branch is elided too', () => {
  for (const id of ['sub-A', 'sub-B']) {
    const lane = lanes[id]

    if (!lane.cells.some(cell => cell.type === 'gap')) {
      throw new Error(`${id} was not elided`)
    }

    if (lane.cells.length >= lane.steps.length) {
      throw new Error(`${id} drew every step (${lane.cells.length})`)
    }
  }
})

check('nothing is dropped silently: visible + hidden accounts for every step', () => {
  for (const [id, lane] of Object.entries(lanes)) {
    const drawn = lane.cells.filter(cell => cell.type === 'step').length
    const hidden = lane.cells.filter(cell => cell.type === 'gap').reduce((sum, cell) => sum + cell.hidden, 0)

    if (drawn + hidden !== lane.steps.length) {
      throw new Error(`${id}: ${drawn} drawn + ${hidden} hidden != ${lane.steps.length} steps`)
    }
  }
})

check('two chips in a lane do not confuse the click-open', () => {
  $expandedLanes.set({ [`${SID}:${task.id}|main`]: true })
  const opened = layoutGraph(trail, new Set([`${task.id}|main`]))
  const openedMain = opened.tasks[0].lanes.find(lane => lane.id === 'main')

  if (openedMain.cells.some(cell => cell.type === 'gap')) {
    throw new Error('a chip survived the expansion')
  }

  if (openedMain.cells.filter(cell => cell.type === 'step').length !== openedMain.steps.length) {
    throw new Error('not every step came back')
  }

  if (openedMain.cells[openedMain.cells.length - 1].type !== 'collapse') {
    throw new Error('no collapse toggle while open')
  }

  $expandedLanes.set({})
})

check('no NaN anywhere', () => {
  if (/NaN/.test(html)) {
    throw new Error('NaN in markup')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nstructure checks passed')
process.exit(failures ? 1 : 0)
