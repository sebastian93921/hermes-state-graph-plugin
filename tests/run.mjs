/**
 * Offline smoke test for the state-graph disk plugin.
 *
 * Exercises the real module: register() -> gateway event replay -> pane render
 * (graph + trail), statusbar chip, transcript directives, palette commands,
 * history seeding, and the expanded card body.
 *
 * The SDK is stubbed locally (node_modules/@hermes/plugin-sdk) because the
 * app's UI kit only resolves inside the Vite build; React + nanostores are the
 * app's own copies. Run with NODE_ENV=production (the app's own mode) so React's
 * dev-only list-key validator doesn't drown the output — the bundled app ships
 * production React and disk plugins render inside it.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { renderToString } from 'react-dom/server'

import { __emit, __resetHost, host } from '@hermes/plugin-sdk'

import plugin from './plugin.js'

let failures = 0
const check = (label, fn) => {
  try {
    const out = fn()

    console.log(`  ok   ${label}`)
    return out
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
    return null
  }
}

const contributions = []
const disposers = []
const ctx = {
  source: 'plugin:state-graph',
  register: c => {
    contributions.push(c)
    return () => {}
  },
  registerMany: cs => {
    cs.forEach(c => contributions.push(c))
  },
  onDispose: fn => disposers.push(fn),
  rest: async () => ({}),
  socket: () => () => {},
  os: { revealPath: async p => (console.log('    [os.revealPath]', p), true) },
  storage: { get: async () => null, set: async () => {} },
  i18n: { register: () => {} }
}

console.log('register()')
check('plugin registers', () => plugin.register(ctx))
check('pane contribution', () => {
  if (!contributions.find(c => c.area === 'panes')) {
    throw new Error('no panes contribution')
  }
})
check('statusbar contribution registered', () => {
  if (!contributions.some(c => c.area === 'statusBar.right')) {
    throw new Error('no statusbar contribution')
  }
})
check('two transcript directives (state-graph, tool-trail)', () => {
  const names = contributions.filter(c => c.area === 'transcript.directives').map(c => c.data?.name)

  if (names.join(',') !== 'state-graph,tool-trail') {
    throw new Error(`directives = ${names}`)
  }
})
check('two palette commands, both runnable', () => {
  const cmds = contributions.filter(c => c.area === 'palette')

  if (cmds.length !== 2) {
    throw new Error(`palette = ${cmds.length}`)
  }

  cmds.forEach(c => c.data.run())
})

const pane = contributions.find(c => c.area === 'panes')
const chip = contributions.find(c => c.area === 'statusBar.right')
const directives = contributions.filter(c => c.area === 'transcript.directives')
const toggleView = () => contributions.find(c => c.area === 'palette' && c.data.id.endsWith('.view')).data.run()
const setView = want => {
  if (!renderToString(pane.render()).includes(`>${want}</button>`)) {
    return
  }

  // The header chip carrying the active class is the current view.
  for (let i = 0; i < 2; i += 1) {
    const html = renderToString(pane.render())
    const active = html.match(/bg-\(--ui-control-active-background\)[^>]*>([a-z]+)</g) || []

    if (active.some(entry => entry.endsWith(`>${want}<`))) {
      return
    }

    toggleView()
  }
}

const SID = 'sess-live-1'
host.state.focusedSessionId.set(SID)
host.state.activeSessionId.set(SID)

const render = label => {
  const paneHtml = check(`pane renders: ${label}`, () => renderToString(pane.render()))

  check(`chip renders: ${label}`, () => renderToString(chip.render()))
  directives.forEach(d => check(`directive ${d.data.name} renders: ${label}`, () => renderToString(d.data.render())))

  return paneHtml
}

const has = (html, needle) => Boolean(html && html.includes(needle))

render('idle, before any turn')

console.log('\nreplay: turn -> thinking -> text -> tool draft -> tool run -> ok + failed -> done')
host.state.busy.set(true)
__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'thinking.delta', session_id: SID, payload: { text: 'considering' } })
__emit({ type: 'message.delta', session_id: SID, payload: { text: 'Working on it' } })
__emit({ type: 'tool.generating', session_id: SID, payload: { name: 'terminal' } })
__emit({
  type: 'tool.start',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 't1', args: { command: 'ls -la' }, preview: 'ls -la' }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'terminal', tool_id: 't1', result: 'total 8\ndrwxr-xr-x', duration_s: 0.4 }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: {
    name: 'read_file',
    tool_id: 't2',
    args: { file_path: '/home/parrot/workspace/AGENTS.md' },
    preview: 'AGENTS.md',
    error: 'permission denied',
    duration_s: 1.2
  }
})
__emit({
  type: 'tool.start',
  session_id: SID,
  payload: { name: 'state_graph_note', tool_id: 'n1', args: { summary: 'building the state graph plugin (first version)' } }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', tool_id: 'n1', result: '{"ok":true}', duration_s: 0.05 }
})
__emit({
  type: 'subagent.spawn_requested',
  session_id: SID,
  payload: { subagent_id: 'sub-1', goal: 'audit the tool card wording', task_index: 0 }
})
__emit({
  type: 'subagent.tool',
  session_id: SID,
  payload: { subagent_id: 'sub-1', goal: 'audit the tool card wording', tool_name: 'search_files', tool_preview: 'grep -rn card' }
})
__emit({
  type: 'subagent.tool',
  session_id: SID,
  payload: { subagent_id: 'sub-1', goal: 'audit the tool card wording', tool_name: 'read_file', tool_preview: 'cards.tsx' }
})
__emit({
  type: 'subagent.complete',
  session_id: SID,
  payload: { subagent_id: 'sub-1', goal: 'audit the tool card wording', status: 'completed', summary: 'wording checked' }
})
__emit({ type: 'clarify.request', session_id: SID, payload: { request_id: 'q1', question: 'which?' } })
__emit({
  type: 'tool.start',
  session_id: SID,
  payload: { name: 'web_search', tool_id: 't3', args: { query: 'hermes docs' } }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'web_search', tool_id: 't3', result: '3 results', duration_s: 2.5 }
})
__emit({
  type: 'tool.start',
  session_id: SID,
  payload: { name: 'state_graph_note', tool_id: 'n2', args: { summary: 'adding agent-authored summaries to the nodes' } }
})
__emit({
  type: 'tool.complete',
  session_id: SID,
  payload: { name: 'state_graph_note', tool_id: 'n2', result: '{"ok":true}', duration_s: 0.05 }
})
__emit({ type: 'message.start', session_id: SID, payload: {} })
__emit({ type: 'message.complete', session_id: SID, payload: { status: 'ok' } })
host.state.busy.set(false)

setView('trail')
const afterTurn = render('after a full turn')


console.log('\nassertions on the rendered trail (cards between prompt and answer)')
check('card title describes the TASK, not the tool', () => {
  for (const needle of ['Ran ls -la', 'Read AGENTS.md']) {
    if (!has(afterTurn, needle)) {
      throw new Error(`missing task title: ${needle}`)
    }
  }
})
check('raw tool name kept as a tag for traceability', () => {
  for (const needle of ['>terminal<', '>read_file<']) {
    if (!has(afterTurn, needle)) {
      throw new Error(`missing tool tag: ${needle}`)
    }
  }
})
check('failed card toned bad', () => {
  if (!has(afterTurn, 'StatusDot:bad')) {
    throw new Error('no bad-toned status dot')
  }
})
check('duration rendered', () => {
  if (!has(afterTurn, '0.4s')) {
    throw new Error('missing duration')
  }
})
check('cards tagged with their turn', () => {
  if (!has(afterTurn, 'turn 1')) {
    throw new Error('missing turn tag')
  }
})
check('status line shows a mode word', () => {
  if (!/>Working</.test(afterTurn) && !/>Done</.test(afterTurn)) {
    throw new Error('no mode badge in the status line')
  }
})

console.log('\nassertions on the state graph')
toggleView()
const graphHtml = check('pane renders: graph view', () => renderToString(pane.render()))
const strip = html => html.replace(/<[^>]*>/g, '')
const grab = (html, cls) =>
  [...html.matchAll(new RegExp(`<text class="${cls}"[^>]*>([\\s\\S]*?)</text>`, 'g'))].map(m => strip(m[1]).trim())
const taskLabels = grab(graphHtml || '', 'sg-task-label')
const taskRects = ((graphHtml || '').match(/class="sg-task"/g) || []).length
const flatText = strip((graphHtml || '').replace(/<\/text>/g, ' '))
const laneLabels = grab(graphHtml || '', 'sg-lane-label')
const activities = grab(graphHtml || '', 'sg-activity')
const stepCount = ((graphHtml || '').match(/class="sg-node"/g) || []).length
const edgeCount = ((graphHtml || '').match(/class="sg-edge"/g) || []).length

console.log('  task columns:', taskLabels.join(' || '))
console.log('  lane labels:', laneLabels.join(' | '))
console.log('  steps:', activities.join(' | '))
console.log('  steps/edges:', stepCount, '/', edgeCount)

check('one BAND per agent-authored task', () => {
  if (taskRects !== 2) {
    throw new Error(`expected 2 task bands, got ${taskRects}`)
  }

  for (const needle of ['building the state', 'adding']) {
    if (!has(flatText, needle)) {
      throw new Error(`task band missing the agent summary ("${needle}")`)
    }
  }

  console.log('  task text:', taskLabels.join(' / '))
})
check('no fabricated task or step labels', () => {
  const fakes = ['running commands', 'thinking it through', 'editing plugin.js', 'reading files', 'searching the codebase']

  for (const fake of fakes) {
    if (has(graphHtml, fake)) {
      throw new Error(`invented label leaked: ${fake}`)
    }
  }
})
check('steps are concrete activities, not tool names', () => {
  for (const needle of ['ran ls -la', 'read AGENTS.md']) {
    if (!activities.some(text => text.startsWith(needle))) {
      throw new Error(`missing step "${needle}" in [${activities.join(' | ')}]`)
    }
  }
})
check('a parallel subagent gets its OWN lane inside the task', () => {
  if (!laneLabels.some(text => text.includes('audit the tool card wordi'))) {
    throw new Error(`no subagent lane label in [${laneLabels.join(' | ')}]`)
  }

  for (const needle of ['search_files', 'read_file']) {
    if (!activities.some(text => text.includes(needle))) {
      throw new Error(`subagent step "${needle}" is missing from its lane`)
    }
  }
})
check('state_graph_note never becomes a task, a step, or a card', () => {
  if (has(graphHtml, 'state_graph_note') || has(afterTurn, 'state_graph_note')) {
    throw new Error('the note tool leaked into the UI')
  }
})
check('flow is forward-only, no dashed loop-backs', () => {
  // The only dash pattern now is the marching 6/6 dash of the ACTIVE edge
  // (the old static dashed back-edge is gone). Animate lives in its place.
  if (!has(graphHtml, 'stroke-dasharray="0.1 7"')) {
    throw new Error('the active edge lost its static small-dot pattern')
  }

  if (!has(graphHtml, 'stroke-dasharray="0.1 39"')) {
    throw new Error('the fat-dot overlay is missing')
  }

  if (!has(graphHtml, 'calcMode="discrete"')) {
    throw new Error('the fat dot must hop slot-to-slot, not slide')
  }

  const hopSeq = (graphHtml.match(/attributeName="stroke-dashoffset" values="([^"]*)"/) || [])[1] || ''
  const frames = hopSeq.split(';').map(Number)

  if (frames.length !== 6 || frames.some(n => !Number.isFinite(n))) {
    throw new Error(`hop must carry 6 finite frames, got "${hopSeq}"`)
  }

  for (let i = 1; i < 5; i++) {
    if ((frames[i - 1] + 8) % 40 !== frames[i]) {
      throw new Error(`hop frame ${i}: ${frames[i - 1]} -> ${frames[i]} is not one 8px slot`)
    }
  }

  if (frames[5] !== frames[0]) {
    throw new Error('the hop cycle must wrap to its resting frame')
  }

  if (!has(graphHtml, 'stroke-linecap="round"')) {
    throw new Error('the dots need round caps')
  }

  if (has(graphHtml, 'ran earlier')) {
    throw new Error('seeded edges are labelled')
  }

  if (!has(graphHtml, 'marker-end="url(#sg-arrow')) {
    throw new Error('no arrowheads')
  }
})
check('every lane is a chain: one link per step, minus each lane head', () => {
  // Steps sit in (task, lane) groups; a lane of n steps draws n-1 links, plus
  // one entry arrow per lane under a task header. Without reading the store the
  // conservative invariant is: at least one link per step beyond the lane heads,
  // and never more links than steps.
  if (edgeCount < stepCount - laneLabels.length - 1 || edgeCount > stepCount) {
    throw new Error(`${stepCount} steps / ${laneLabels.length} extra lanes drew ${edgeCount} links`)
  }
})
check('no "work" row above the graph (the trail carries the work)', () => {
  if (has(graphHtml, '>work<')) {
    throw new Error('work strip still rendered')
  }
})
check('current step is marked (halo around the live card)', () => {
  const halos = ((graphHtml || '').match(/class="sg-halo"/g) || []).length

  if (halos !== 1) {
    throw new Error(`expected exactly one halo, found ${halos}`)
  }
})
check('transitions are labelled with verbs', () => {
  const labels = grab(graphHtml || '', 'sg-edge-label')

  for (const label of ['thinks', 'calls tool', 'subagent runs']) {
    if (!labels.includes(label)) {
      throw new Error(`missing transition label ${label} in [${labels.join(' | ')}]`)
    }
  }
})
check('no NaN geometry in the svg', () => {
  if (has(graphHtml, 'NaN')) {
    throw new Error('NaN coordinate in the rendered graph')
  }
})
check('status line reports the CURRENT agent task', () => {
  const html = renderToString(pane.render())

  if (!has(html, 'adding agent-authored summaries to the nodes')) {
    throw new Error('status line does not carry the agent summary')
  }
})
check('trail groups cards under the agent-written summary', () => {
  if (!has(afterTurn, 'building the state graph plugin (first version)')) {
    throw new Error('trail missing the agent summary group header')
  }
})

console.log('\ntodo fallback: the agent\u2019s own plan item opens a band (no note tool)')
{
  const SID3 = 'sess-todo-only'
  host.state.focusedSessionId.set(SID3)
  host.state.activeSessionId.set(SID3)
  host.state.busy.set(true)
  __emit({
    type: 'tool.start',
    session_id: SID3,
    payload: { name: 'terminal', tool_id: 'x1', args: { command: 'ls' } }
  })
  __emit({
    type: 'tool.complete',
    session_id: SID3,
    payload: { name: 'terminal', tool_id: 'x1', result: 'ok', duration_s: 0.1 }
  })
  __emit({
    type: 'todo.updated',
    session_id: SID3,
    payload: {
      todos: [
        { id: '1', content: 'wire the band fallback', status: 'in_progress' },
        { id: '2', content: 'ship it', status: 'pending' }
      ]
    }
  })
  __emit({
    type: 'tool.start',
    session_id: SID3,
    payload: { name: 'patch', tool_id: 'x2', args: { path: '/repo/plugin.js' } }
  })
  __emit({
    type: 'tool.complete',
    session_id: SID3,
    payload: { name: 'patch', tool_id: 'x2', result: 'updated', duration_s: 0.3 }
  })
  host.state.busy.set(false)

  const html = renderToString(pane.render())
  const bands = (html.match(/class="sg-task"/g) || []).length

  check('a todo item with no note still opens a task band', () => {
    if (bands !== 1) {
      throw new Error(`expected 1 band, got ${bands}`)
    }

    if (!has(html, 'wire the band fallback')) {
      throw new Error('band title is not the todo item')
    }
  })
  check('the steps after it are grouped in that band', () => {
    const nodes = (html.match(/class="sg-node"/g) || []).length

    if (nodes < 2) {
      throw new Error(`expected the tool steps to be drawn, got ${nodes}`)
    }

    if (has(html, 'NaN')) {
      throw new Error('NaN geometry')
    }
  })
}

console.log('\nexpanded card body (args / result / copy affordances)')
const source = readFileSync('./plugin.js', 'utf8')

writeFileSync('./plugin.probe.js', `${source}\nexport const __probe = { ToolCard, $expanded }\n`)

const { __probe } = await import('./plugin.probe.js')
const card = {
  key: 't1',
  name: 'terminal',
  turn: 1,
  seeded: false,
  status: 'ok',
  preview: 'ls -la',
  args: { command: 'ls -la' },
  result: 'total 8',
  error: null,
  diff: null,
  startedAt: 0,
  endedAt: 10,
  durationS: 0.4
}

const expandedHtml = check('expanded card renders', () =>
  renderToString(__probe.ToolCard({ card, expanded: true, onToggle: () => {}, onReveal: () => {} }))
)

check('expanded body shows args + result + copy buttons', () => {
  for (const needle of ['args', 'result', 'Copy args', 'Copy result', 'ls -la', 'total 8']) {
    if (!has(expandedHtml, needle)) {
      throw new Error(`missing ${needle}`)
    }
  }
})

check('terminal args are broken into command + timeout rows', () => {
  const termCard = {
    ...card,
    key: 't-term',
    name: 'terminal',
    task: { command: 'npm run build', verb: 'Ran' },
    argRows: [
      { key: 'command', value: 'npm run build -- --watch' },
      { key: 'timeout', value: '300' }
    ],
    args: { command: 'npm run build -- --watch', timeout: 300 }
  }
  const html = renderToString(
    __probe.ToolCard({ card: termCard, expanded: true, onToggle: () => {}, onReveal: () => {} })
  )

  for (const needle of ['command', 'npm run build -- --watch', 'timeout', '300']) {
    if (!has(html, needle)) {
      throw new Error(`missing ${needle} in the terminal card body`)
    }
  }

  // the command block must come BEFORE the timeout line
  if (html.indexOf('npm run build -- --watch') > html.indexOf('timeout')) {
    throw new Error('timeout is presented before the command')
  }

  if (has(html, '{&quot;command&quot;')) {
    throw new Error('the raw args JSON is still dumped for terminal')
  }
})

check('expanded body offers reveal for a file-arg card (and not otherwise)', () => {
  const fileCard = {
    ...card,
    key: 't2',
    name: 'read_file',
    args: { file_path: '/home/parrot/workspace/AGENTS.md' },
    preview: 'AGENTS.md'
  }
  const html = renderToString(
    __probe.ToolCard({ card: fileCard, expanded: true, onToggle: () => {}, onReveal: () => {} })
  )

  if (!has(html, 'Reveal file')) {
    throw new Error('missing reveal action on a file-arg card')
  }

  if (has(expandedHtml, 'Reveal file')) {
    throw new Error('reveal offered on a card with no file argument')
  }
})

console.log('\nseed-from-history path (session.history backfill)')
__resetHost({
  messages: [
    { role: 'user', content: 'please audit the plugin loader' },
    {
      role: 'tool',
      name: 'search_files',
      tool_call_id: 'h1',
      context: 'grep -rn plugin',
      args: { pattern: 'plugin' },
      content: '3 matches in 2 files'
    },
    { role: 'assistant', content: 'done' }
  ]
})

const SID2 = 'sess-seeded-2'
host.state.focusedSessionId.set(SID2)
await new Promise(resolve => setTimeout(resolve, 30))
setView('trail')
const seeded = render('seeded session')

check('history card rendered with a history badge', () => {
  if (!has(seeded, 'search_files') || !has(seeded, 'history')) {
    throw new Error('seeded card or badge missing')
  }
})
check('seed did not hijack the live current state', () => {
  toggleView()
  const html = renderToString(pane.render())

  if ((html.match(/> now</) || []).length && html.includes('tool:search_files')) {
    const currentMarked = /tool:search_files<\/tspan>[^<]*<tspan[^>]*> now/.test(html)

    if (currentMarked) {
      throw new Error('seeded state became the current state')
    }
  }

  toggleView()
})
check('prompt captured for the tooltip', () => {
  const html = renderToString(pane.render())

  if (!has(html, 'audit the plugin loader')) {
    throw new Error('prompt not captured')
  }
})

console.log('\ndispose')
disposers.forEach(fn => fn())
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
