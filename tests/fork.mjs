// Fan-out probe: does the graph draw
//     [a] -> [b]
//              +-> [c1] -> [d1]
//              +-> [c2] -> [d2]
// i.e. do the branch lanes start to the RIGHT of the node that spawned them,
// at a shared column, joined by elbows from one point?
import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, layoutGraph, $trails } from './plugin.js'

host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })

const SID = 'fork-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)
host.state.busy.set(true)

const tool = (name, id, args = {}, result = 'ok') => {
  __emit({ type: 'tool.start', session_id: SID, payload: { name, tool_id: id, args, preview: name } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name, tool_id: id, args, result, duration_s: 0.2 } })
}

// [a] -> [b]: the work that leads up to the fan-out, then the fan-out itself
tool('state_graph_note', 'n1', { summary: 'fanning the audit out to two subagents' })
tool('terminal', 't-a', { command: 'git status' })
tool('delegate_task', 't-b', { tasks: ['audit the cards', 'run the harness'] })

// two branches
for (const [sid, goal, one, two] of [
  ['sub-A', 'audit the cards', 'search_files', 'read_file'],
  ['sub-B', 'run the harness', 'grep_files', 'list_files']
]) {
  __emit({ type: 'subagent.spawn_requested', session_id: SID, payload: { subagent_id: sid, goal, task_index: 0 } })
  __emit({ type: 'subagent.tool', session_id: SID, payload: { subagent_id: sid, goal, tool_name: one, tool_preview: one } })
  __emit({ type: 'subagent.tool', session_id: SID, payload: { subagent_id: sid, goal, tool_name: two, tool_preview: two } })
  __emit({ type: 'subagent.complete', session_id: SID, payload: { subagent_id: sid, goal, status: 'completed', summary: 'done' } })
}

const trail = $trails.get()[SID]
const layout = layoutGraph(trail)
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

const forks = [...html.matchAll(/d="(M [^"]*)"[^>]*class="sg-edge sg-edge-fork"|class="sg-edge sg-edge-fork"[^>]*?\sd="(M [^"]*)"/g)].map(m => m[1] || m[2])
const keyed = Object.entries(layout.positions)
const byKey = k => keyed.find(([key]) => key.includes(k))?.[1]
const spawn = byKey('delegate_task')
const c1 = byKey('search_files')
const c2 = byKey('grep_files')
const d1 = byKey('read_file')
const d2 = byKey('list_files')

console.log('TRAIL KEYS:', Object.keys(trail).join(','))
console.log('ORDER:', trail.order.slice(0, 6).join(' | '))
const firstKey = trail.order[0]
console.log('SAMPLE:', JSON.stringify(trail[Object.keys(trail).find(k => Array.isArray(trail[k]))]?.[0] || null).slice(0, 300))
console.log('STEPS LIKE:', JSON.stringify(Object.keys(trail).filter(k => /step|card|node/i.test(k))))
const sample = trail.cards?.['T1|sub-A|tool:search_files~4'] || trail.nodes?.['T1|sub-A|tool:search_files~4'] || trail.cards?.find?.(() => true)
console.log('CARD SAMPLE:', JSON.stringify(sample))
console.log('CARD KEYS:', JSON.stringify(Object.keys(trail.cards || {}).slice(0, 4)))
console.log('NODE SAMPLE:', JSON.stringify(trail.nodes?.['tool:search_files'] || Object.values(trail.nodes || {})[0]).slice(0, 260))
console.log('LANES:', JSON.stringify(layout.tasks.flatMap(t => (t.lanes || []).map(l => ({ id: l.id, forkCol: l.forkCol, forkFrom: l.forkFrom, y: l.y, cells: l.cells.map(c => c.type === 'gap' ? 'GAP' : `${c.step.key}@${c.col}`) }))), null, 1))
console.log('POSITIONS:', JSON.stringify(layout.positions))
console.log('fork edges:', forks.length)
console.log('spawn node :', JSON.stringify(spawn))
console.log('branch c1  :', JSON.stringify(c1), ' c2:', JSON.stringify(c2))
console.log('branch d1  :', JSON.stringify(d1), ' d2:', JSON.stringify(d2))
console.log('forks      :', forks.map(d => d.slice(0, 46)).join(' || '))
console.log('NaN:', /NaN/.test(html) ? 'YES' : 'no')

check('both branches are drawn', () => {
  for (const [label, pos] of [['c1', c1], ['c2', c2], ['d1', d1], ['d2', d2]]) {
    if (!pos) {
      throw new Error(`branch card ${label} has no position`)
    }
  }
})

check('the spawn node sits left of both branches', () => {
  if (!(spawn.x < c1.x && spawn.x < c2.x)) {
    throw new Error(`spawn x=${spawn.x} is not left of c1=${c1.x} / c2=${c2.x}`)
  }
})

check('the branches share one column, right of the spawn node', () => {
  if (c1.x !== c2.x) {
    throw new Error(`branch heads at different columns: ${c1.x} vs ${c2.x}`)
  }

  if (!(c1.x > spawn.x)) {
    throw new Error(`branch column ${c1.x} is not right of the spawn node (${spawn.x})`)
  }

  if ((c1.x - spawn.x) % 226 !== 0) {
    throw new Error(`branch column ${c1.x} is not a whole number of cells from the spawn node (${spawn.x})`)
  }

  // The branch head is the worker's own card (the subagent marker), one cell
  // right of the node that spawned it.
  const head = byKey('subagent')
  if (!head || head.x !== spawn.x + 226) {
    throw new Error(`branch head is not one cell right of the spawn node: ${JSON.stringify(head)} vs ${spawn.x + 226}`)
  }
})

check('each branch keeps its own row, and continues right', () => {
  if (c1.y === c2.y) {
    throw new Error('both branches share a row')
  }

  if (!(d1.x > c1.x && d2.x > c2.x)) {
    throw new Error('a branch does not continue to the right of its head')
  }
})

check('two elbows leave the spawn node from the same point', () => {
  if (forks.length !== 2) {
    throw new Error(`expected 2 fork edges, found ${forks.length}`)
  }

  const starts = forks.map(d => d.match(/^M ([\d.-]+) ([\d.-]+)/))

  for (const s of starts) {
    if (!s) {
      throw new Error(`fork path is not an elbow: ${forks[0]}`)
    }
  }

  if (forks.some(d => !/H [\d.-]+ V [\d.-]+ H [\d.-]+/.test(d))) {
    throw new Error(`fork path is not an orthogonal elbow: ${forks.join(' || ')}`)
  }

  const expectX = spawn.x + 148 // STEP_W: the spawn card's right edge

  if (starts.some(s => Number(s[1]) !== expectX)) {
    throw new Error(`elbow does not leave the spawn node's right edge: ${starts.map(s => s[1]).join(',')} vs ${expectX}`)
  }

  if (starts[0][1] !== starts[1][1] || starts[0][2] !== starts[1][2]) {
    throw new Error(`elbows leave different points: ${starts[0].slice(1)} vs ${starts[1].slice(1)}`)
  }
})

check('no NaN reached the markup', () => {
  if (/NaN/.test(html)) {
    throw new Error('NaN in markup')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nfork checks passed')
process.exit(failures ? 1 : 0)
