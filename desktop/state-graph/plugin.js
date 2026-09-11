/**
 * state-graph — the agent's live state machine + an interactive tool-card audit
 * trail, rendered inside the Hermes desktop app.
 *
 * Surfaces:
 *   - PANE        "Agent State Graph": a layered SVG of the agent's distinct
 *                 states (nodes named after the state / tool) with counted
 *                 transitions, the CURRENT node highlighted and the PREVIOUS
 *                 one marked — plus the tool cards of the run.
 *   - TRAIL       one interactive card per tool call, in the order they ran,
 *                 sitting between the prompt and the final answer.
 *   - STATUSBAR   the current state name as a chip.
 *   - PALETTE     reset / follow / view commands.
 *   - DIRECTIVES  `::state-graph{}` and `::tool-trail{}` so the assistant can
 *                 render both inline in a message.
 *
 * Data comes from `host.onEvent('*')` (gateway event stream) — no backend half,
 * no polling loop. `session.history` seeds the run's trail once per session so
 * the pane is never empty.
 *
 * Disk plugin: plain ESM, no JSX syntax (build elements with jsx/jsxs).
 */

import {
  Badge,
  Button,
  Codicon,
  CopyButton,
  EmptyState,
  GlyphSpinner,
  ScrollArea,
  StatusDot,
  Tip,
  atom,
  cn,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef } from 'react'

const PLUGIN_ID = 'state-graph'
const MAX_NODES = 40
const MAX_SEED_NODES = 8
const MAX_CARDS = 200

// ── plugin-local state ─────────────────────────────────────────────────────
// Per-session trail: nodes/edges of the state graph + the ordered tool cards.
// A nanostore atom per store; every mutation publishes a NEW object so the
// subscribed components re-render.

const $trails = atom({})
const $view = atom('graph') // 'graph' | 'trail'
const $filter = atom('all') // 'all' | 'turn' | 'failed'
const $expanded = atom({}) // 'sid:cardKey' -> bool
const $follow = atom(true) // follow the focused chat, or pin one
const $expandedLanes = atom({}) // 'sid:taskId|laneId' -> the elided middle is open
const $pinned = atom('') // pinned runtime session id
const $detail = atom('') // 'sid:nodeKey' of the node the last click inspected

const emptyTrail = sid => ({
  sid,
  prompt: '',
  status: 'idle',
  turn: 0,
  seeded: false,
  drafting: '',
  phase: '',
  workSource: '',
  tasks: [],
  currentTask: '',
  lanes: { main: { at: 0, id: 'main', label: 'main', status: 'active' } },
  currentLane: 'main',
  seq: 0,
  currentBase: '',
  lastNode: '',
  order: [],
  nodes: {},
  edges: {},
  current: '',
  previous: '',
  startedAt: 0,
  endedAt: 0,
  cards: []
})

const trailsMap = () => $trails.get()

function freshDraft(base, sid) {
  const t = base ?? emptyTrail(sid)

  return {
    ...t,
    nodes: { ...t.nodes },
    edges: { ...t.edges },
    order: t.order.slice(),
    cards: t.cards.slice()
  }
}

function commit(draft) {
  const all = trailsMap()

  $trails.set({ ...all, [draft.sid]: draft })
}

/** Read-modify-write one session's trail. `fn` mutates the draft in place. */
function mutate(sid, fn) {
  if (!sid) {
    return
  }

  const draft = freshDraft(trailsMap()[sid], sid)

  fn(draft)
  commit(draft)
}

/** Drop the oldest node (and its edges) so the flow stays a window on the run
 *  instead of an unbounded chain. */
function pruneFlow(draft) {
  while (draft.order.length > MAX_NODES) {
    const oldest = draft.order[0]

    draft.order = draft.order.slice(1)
    delete draft.nodes[oldest]
    draft.edges = Object.fromEntries(
      Object.entries(draft.edges).filter(([, edge]) => edge.from !== oldest && edge.to !== oldest)
    )
  }
}

/** Create/update one graph node. Returns false when a NEW key can't be added
 *  (node cap) — callers then leave the state machine alone. */
function touchNode(draft, key, kind, name, status, at, summary, place) {
  if (!key) {
    return false
  }

  const existing = draft.nodes[key]

  if (!existing) {
    draft.nodes[key] = {
      key,
      baseKey: place?.baseKey || key,
      kind,
      lane: place?.lane || 'main',
      name: name || key,
      row: place?.row ?? 0,
      summary: summary || '',
      status,
      taskId: place?.taskId || 'T0',
      count: 1,
      firstAt: at,
      lastAt: at
    }
    draft.order = draft.order.concat([key])
    pruneFlow(draft)

    return true
  }

  draft.nodes[key] = {
    ...existing,
    kind: existing.kind || kind,
    name: existing.name || name || key,
    row: place?.row ?? existing.row ?? 0,
    summary: summary || existing.summary || '',
    status,
    count: existing.count + (draft.current === key ? 0 : 1),
    lastAt: at
  }

  return true
}

/** One counted transition between two states. `via` is the label the diagram
 *  draws on the edge (the event that moved the machine). */
function recordEdge(draft, from, to, at, via) {
  if (!from || !to || from === to) {
    return
  }

  const edgeKey = from + '>' + to
  const edge = draft.edges[edgeKey]

  draft.edges[edgeKey] = edge
    ? { ...edge, count: edge.count + 1, lastAt: at, via: edge.via || via || '' }
    : { from, to, count: 1, lastAt: at, via: via || '' }
}

/** Label for the transition a gateway event just caused. Set by `handleEvent`
 *  (single-threaded, synchronous mutate) and read by `enter`. */
let pendingVia = ''

/** Step the machine forward inside its LANE.
 *
 *  The graph is TASKS x LANES x STEPS: the task is the agent's summary column,
 *  the lane is the worker (main, or a subagent running in parallel), and a step
 *  is one thing that worker did. Staying on the same state refreshes its step;
 *  leaving and coming back appends the next step in the lane, so nothing ever
 *  arrows backwards. Returns false when nothing changed, so stream deltas never
 *  churn the store. */
function enter(draft, baseKey, kind, name, status, at, fallback) {
  if (!baseKey) {
    return false
  }

  const taskId = draft.currentTask || 'T0'
  const lane = draft.currentLane || 'main'
  const declared = EXPLICIT_WORK.has(draft.workSource) && draft.phase ? draft.phase : ''
  const current = draft.nodes[draft.current]

  // Same state, same place in the run: refresh it in place.
  if (current && current.baseKey === baseKey && current.taskId === taskId && current.lane === lane) {
    if (current.status === status && current.name === name) {
      return false
    }

    draft.nodes[draft.current] = {
      ...current,
      kind,
      name,
      status,
      summary: declared || current.summary || '',
      lastAt: at
    }

    return true
  }

  const key = `${taskId}|${lane}|${baseKey}~${draft.seq + 1}`
  const row = draft.order.filter(
    other => draft.nodes[other] && draft.nodes[other].taskId === taskId && draft.nodes[other].lane === lane
  ).length

  if (!touchNode(draft, key, kind, name, status, at, declared || fallback || '', { baseKey, lane, row, taskId })) {
    return false
  }

  draft.seq += 1
  recordEdge(draft, current ? current.key : '', key, at, pendingVia)
  draft.previous = current ? current.key : draft.previous
  draft.current = key
  draft.currentBase = baseKey
  draft.lastNode = key

  return true
}

/** Mark a node's status without moving the current pointer (e.g. a tool that
 *  reports its own completion). */
function mark(draft, key, status, at) {
  const existing = draft.nodes[key]

  if (!existing || existing.status === status) {
    return
  }

  draft.nodes[key] = { ...existing, status, lastAt: at }
}

// Anything that reaches an SVG attribute must be a real number: a single NaN
// silently blanks the whole path/transform, and the graph is dense float
// geometry (hypot/atan2/rotate). Coerce at the boundary instead of trusting it.
const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)

const clip = (value, max) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)

  return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text
}

const asText = value => {
  if (value == null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const firstLine = value => asText(value).split('\n')[0]

function toolKeyOf(payload, draft, name, status) {
  const explicit = payload?.tool_id || payload?.tool_call_id

  if (typeof explicit === 'string' && explicit) {
    return explicit
  }

  // No id from the gateway: glue a completion onto the newest card of the same
  // name that is still open (drafting/running), otherwise open a new one.
  for (let i = draft.cards.length - 1; i >= 0; i -= 1) {
    const card = draft.cards[i]

    if (card.name === name && (card.status === 'running' || card.status === 'drafting')) {
      return card.key
    }
  }

  return `${name}#${status === 'complete' ? 'late' : draft.cards.length + 1}`
}

function upsertCard(draft, payload, status, at) {
  const name =
    typeof payload?.name === 'string' && payload.name
      ? payload.name
      : typeof payload?.tool_name === 'string' && payload.tool_name
        ? payload.tool_name
        : 'tool'

  const key = toolKeyOf(payload, draft, name, status)
  const index = draft.cards.findIndex(card => card.key === key)
  const args = payload?.args ?? payload?.arguments ?? payload?.input
  const previous = index >= 0 ? draft.cards[index] : null
  const resolvedArgs = args !== undefined ? args : previous?.args
  // The task description is derived from the RESOLVED args, so a completion
  // frame (which carries no args) keeps the wording the start frame produced.
  const task = describeTask(name, resolvedArgs, payload)

  const card = {
    key,
    name,
    task,
    argRows: argRows(name, resolvedArgs),
    phase: previous?.phase || draft.phase || '',
    turn: previous?.turn ?? draft.turn,
    seeded: false,
    status,
    preview: firstLine(payload?.preview ?? payload?.summary ?? payload?.context ?? previous?.preview ?? ''),
    command: task.command || previous?.command || '',
    args: resolvedArgs,
    result: payload?.result !== undefined ? payload.result : previous?.result,
    error:
      payload?.error === true
        ? 'failed'
        : typeof payload?.error === 'string' && payload.error
          ? payload.error
          : null,
    diff: typeof payload?.inline_diff === 'string' && payload.inline_diff ? payload.inline_diff : previous?.diff,
    startedAt: previous?.startedAt ?? at,
    endedAt: status === 'complete' ? at : 0,
    durationS:
      typeof payload?.duration_s === 'number' && payload.duration_s > 0
        ? payload.duration_s
        : status === 'complete'
          ? Math.max(0, ((at - (previous?.startedAt ?? at)) / 1000))
          : 0
  }

  if (card.status === 'complete') {
    card.status = card.error ? 'error' : 'ok'
  }

  if (index >= 0) {
    const next = draft.cards.slice()

    next[index] = card
    draft.cards = next
  } else {
    draft.cards = draft.cards.concat([card]).slice(-MAX_CARDS)
  }

  return card
}

const KIND_COLORS = {
  state: 'var(--ui-blue)',
  tool: 'var(--ui-purple)',
  draft: 'var(--ui-cyan)',
  plan: 'var(--ui-green)',
  input: 'var(--ui-orange)',
  subagent: 'var(--ui-yellow)',
  error: 'var(--ui-red)'
}

const KIND_LABELS = {
  state: 'agent state',
  tool: 'tool call',
  draft: 'drafting call',
  plan: 'plan',
  input: 'needs input',
  subagent: 'subagent',
  error: 'error'
}

const kindColor = kind => KIND_COLORS[kind] || 'var(--ui-text-tertiary)'

const STATUS_TONE = { ok: 'good', complete: 'good', error: 'bad', running: 'warn', drafting: 'warn', active: 'warn' }

/** The tool the agent calls to say what it is working on (agent half lives in
 *  `$HERMES_HOME/plugins/state-graph/plugin.py`). Its CALL is the message — the
 *  desktop half reads the args straight off the event stream. */
const NOTE_TOOL = 'state_graph_note'

/** Work summaries only ever come from the AGENT: a `state_graph_note` call, or
 *  its own todo list. Nothing is guessed from tool args — "editing plugin.js"
 *  is an activity, not a statement of what the work is. */
const EXPLICIT_WORK = new Set(['agent', 'todo'])

/** The agent's sentence, however the call was shaped: a plain string, or the
 *  whole call passed as one string/repr (``{"summary": "…"}``) — never let that
 *  repr reach a card. */
function unwrapSummary(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return unwrapSummary(value.summary)
  }

  const text = String(value ?? '').replace(/\s+/g, ' ').trim()

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const data = JSON.parse(text.replace(/'/g, '"'))

      if (data && typeof data.summary === 'string') {
        return unwrapSummary(data.summary)
      }
    } catch {
      // not JSON — fall through to the regex lift
    }

    const match = text.match(/summary['"]?\s*[:=]\s*['"]([^'"]+)/i)

    if (match) {
      return match[1].replace(/\s+/g, ' ').trim()
    }
  }

  return text
}

/** The text of a `state_graph_note` call, or null for any other tool. */
function readWorkNote(payload) {
  if (payload?.name !== NOTE_TOOL) {
    return null
  }

  const args = parseArgs(payload?.args ?? payload?.arguments ?? payload?.input)
  const text = unwrapSummary(args.summary)

  return text ? { status: String(args.status || 'working'), text } : null
}

/** Record a new work phase (what the agent says it is doing) — appended only
 *  when it actually changed, so the work log doesn't grow per heartbeat. */
function noteWork(draft, text, at) {
  const phase = clip(String(text || '').replace(/\s+/g, ' ').trim(), 72)

  if (!phase || draft.phase === phase) {
    return
  }

  draft.phase = phase
}

/** A new agent-authored TASK — one column of the graph. Its text is the header,
 *  and every step that follows lands inside it until the agent names another. */
function startTask(draft, text, at) {
  const label = clip(String(text || '').replace(/\s+/g, ' ').trim(), 72)

  if (!label) {
    return false
  }

  const last = draft.tasks[draft.tasks.length - 1]

  if (last && last.text === label && draft.currentTask) {
    draft.phase = label

    return false
  }

  const id = `T${draft.tasks.length + 1}`

  draft.tasks = draft.tasks.concat([{ id, text: label, at, turn: draft.turn }])
  draft.currentTask = id
  draft.currentLane = 'main'
  draft.phase = label
  draft.workSource = 'agent'

  return true
}

/** The lane a subagent event belongs to, registered on first sight so parallel
 *  workers each get their own chain inside the current task. */
function laneFor(draft, payload, at) {
  const id = String(
    payload?.subagent_id ||
      `${payload?.parent_id || 'root'}:${payload?.task_index ?? 0}:${payload?.goal || payload?.name || ''}`
  )

  if (!id) {
    return 'main'
  }

  if (!draft.lanes[id]) {
    const label = String(payload?.goal || payload?.name || payload?.tool_name || 'subagent')

    draft.lanes = { ...draft.lanes, [id]: { at, id, label: clip(label, 40), status: 'active' } }
  }

  return id
}

/** The agent's own declared step, off a todo_list write: the in-progress item
 *  wins, else the first pending one. */
function todoPhase(payload) {
  const unwrap = value => {
    if (!value) {
      return []
    }

    if (Array.isArray(value)) {
      return value
    }

    return Array.isArray(value.todos) ? value.todos : []
  }

  const items = unwrap(payload?.todos).concat(unwrap(payload?.result))
  const usable = items.filter(item => item && typeof item === 'object' && typeof item.content === 'string')

  if (!usable.length) {
    return ''
  }

  const active =
    usable.find(item => item.status === 'in_progress') ??
    usable.find(item => item.status === 'pending')

  return active ? active.content : ''
}

/** The status line's mode word — the agent's coarse activity, the same way a
 *  coding agent shows "Plan" while it plans. Derived from the node it is in. */
function modeOf(trail) {
  const node = trail?.nodes?.[trail.current]

  if (!node) {
    return trail?.drafting ? { label: 'Preparing a tool', variant: 'muted' } : { label: 'Idle', variant: 'muted' }
  }

  if (node.kind === 'error' || node.status === 'error') {
    return { label: 'Failed', variant: 'destructive' }
  }

  if (node.kind === 'plan') {
    return { label: 'Plan', variant: 'default' }
  }

  if (node.kind === 'input') {
    return { label: 'Needs you', variant: 'warn' }
  }

  if (node.kind === 'subagent') {
    return { label: 'Delegating', variant: 'muted' }
  }

  if (trail?.drafting) {
    return { label: 'Preparing a tool', variant: 'muted' }
  }

  if (node.key === 'done' || node.key === 'compacted') {
    return { label: 'Done', variant: 'success' }
  }

  return { label: 'Working', variant: 'muted' }
}

// ── gateway event tap ──────────────────────────────────────────────────────

function currentSid() {
  return (
    $pinned.get() ||
    host.state.focusedSessionId.get() ||
    host.state.activeSessionId.get() ||
    ''
  )
}

function beginTurn(sid) {
  if (!sid) {
    return
  }

  mutate(sid, draft => {
    draft.turn += 1
    draft.status = 'running'
    draft.startedAt = Date.now()
    draft.endedAt = 0
    draft.current = ''
    draft.currentBase = ''
  })
}

let latestAt = 0

function handleEvent(event) {
  const stamp = Number(event?.at) || 0

  if (stamp) {
    latestAt = stamp
  }

  const sid = typeof event?.session_id === 'string' ? event.session_id : ''
  const type = typeof event?.type === 'string' ? event.type : ''
  const payload = event?.payload || {}
  const at = Date.now()

  if (!sid || !type) {
    return
  }

  pendingVia = TRANSITION_LABELS[type] || type

  // A state_graph_note call is not work — it is the agent SAYING what the work
  // is. It never becomes a card or a node, whatever frame it arrives in (the
  // completion frame carries no args, so it must be matched on NAME alone).
  if (
    payload?.name === NOTE_TOOL &&
    (type === 'tool.start' || type === 'tool.progress' || type === 'tool.complete')
  ) {
    const note = readWorkNote(payload)

    if (note) {
      mutate(sid, draft => startTask(draft, note.text, at))
    }

    return
  }

  // The agent's OWN work summary (the `state_graph_note` tool): it names the
  // work, it is not work itself — no card, no node, and it outranks every
  // heuristic below until the agent says something else.
  const trail = trailsMap()[sid]

  // Stream deltas: only the TRANSITION costs a store write. One working state
  // covers thinking + reasoning — two nodes for the same visible activity made
  // the diagram noisier than the run.
  if (type === 'message.delta' || type === 'message.interim') {
    if (trail?.current === 'answering') {
      return
    }

    mutate(sid, draft => enter(draft, 'answering', 'state', 'answering', 'active', at))

    return
  }

  if (type === 'thinking.delta' || type === 'reasoning.delta' || type === 'reasoning.available') {
    if (trail?.current === 'thinking') {
      return
    }

    mutate(sid, draft => enter(draft, 'thinking', 'state', 'thinking', 'active', at))

    return
  }

  switch (type) {
    case 'message.start':
      if (trail?.current === 'answering') {
        return
      }

      mutate(sid, draft => {
        draft.turn = Math.max(1, draft.turn)
        draft.status = 'running'
        draft.startedAt = draft.startedAt || at
        draft.endedAt = 0
        enter(draft, 'answering', 'state', 'answering', 'active', at)
      })

      return

    case 'message.complete': {
      const failed = payload?.status === 'error'

      mutate(sid, draft => {
        draft.drafting = ''
        enter(
          draft,
          failed ? 'failed' : 'done',
          failed ? 'error' : 'state',
          failed ? 'failed' : 'done',
          failed ? 'error' : 'done',
          at
        )
        draft.status = failed ? 'error' : 'done'
        draft.endedAt = at
      })

      return
    }

    case 'tool.generating': {
      // While the model is still emitting the call's JSON. A node here would
      // double every tool call in the graph, so it is a STATUS, not a state.
      const name = typeof payload?.name === 'string' ? payload.name : ''

      if (!name || trail?.drafting === name) {
        return
      }

      mutate(sid, draft => {
        draft.drafting = name
      })

      return
    }

    case 'tool.start':
    case 'tool.progress':
      mutate(sid, draft => {
        const card = upsertCard(draft, payload, 'running', at)

        draft.drafting = ''
        enter(draft, `tool:${card.name}`, 'tool', taskLabel(card), 'running', at)
      })

      return

    case 'tool.complete':
      mutate(sid, draft => {
        const card = upsertCard(draft, payload, 'complete', at)

        draft.drafting = ''
        enter(draft, `tool:${card.name}`, 'tool', taskLabel(card), card.status, at)
        mark(draft, `tool:${card.name}`, card.status, at)
      })

      return

    case 'status.update': {
      const kind = typeof payload?.kind === 'string' ? payload.kind : ''

      if (kind === 'compacting') {
        mutate(sid, draft => enter(draft, 'compacting', 'state', 'compressing context', 'active', at))
      } else if (kind === 'compacted') {
        mutate(sid, draft => enter(draft, 'compacted', 'state', 'context compressed', 'done', at))
      }

      return
    }

    case 'todo.updated':
      mutate(sid, draft => {
        enter(draft, 'plan', 'plan', 'planning', 'done', at)

        // The agent's own declared step. With no `state_graph_note` in play it
        // also OPENS a task band, so the hierarchy shows up for agents that plan
        // with a todo list instead of calling the note tool.
        const text = todoPhase(payload)

        if (text) {
          if (draft.workSource !== 'agent') {
            startTask(draft, text, at)
            draft.workSource = 'todo'
          } else {
            noteWork(draft, text, at)
          }
        } else if (draft.workSource === 'todo') {
          draft.workSource = ''
        }

      })

      return

    case 'clarify.request':
      mutate(sid, draft => enter(draft, 'needs-input', 'input', 'waiting for you', 'active', at))

      return

    case 'approval.request':
      mutate(sid, draft => enter(draft, 'approval', 'input', 'waiting for approval', 'active', at))

      return

    case 'secret.request':
      mutate(sid, draft => enter(draft, 'credentials', 'input', 'waiting for a secret', 'active', at))

      return

    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.thinking':
    case 'subagent.progress':
      // A parallel worker. It gets its own lane inside the current task, so the
      // graph shows main and subagent running side by side instead of pretending
      // everything is one queue.
      mutate(sid, draft => {
        draft.currentLane = laneFor(draft, payload, at)
        enter(
          draft,
          'subagent',
          'subagent',
          `delegated: ${clip(String(payload?.goal || payload?.name || 'subagent'), 22)}`,
          'active',
          at
        )
        // Not sticky: the agent keeps working while workers run, and those steps
        // belong to the main lane.
        draft.currentLane = 'main'
      })

      return

    case 'subagent.tool': {
      const name = String(payload?.tool_name || payload?.name || 'tool')
      const preview = firstLine(payload?.tool_preview ?? payload?.preview ?? payload?.text)

      mutate(sid, draft => {
        draft.currentLane = laneFor(draft, payload, at)
        enter(draft, `tool:${name}`, 'tool', clip(`${name} ${preview}`.trim(), 30), payload?.error ? 'error' : 'running', at)
        draft.currentLane = 'main'
      })

      return
    }

    case 'subagent.complete':
      mutate(sid, draft => {
        const lane = laneFor(draft, payload, at)

        if (draft.lanes[lane]) {
          draft.lanes = {
            ...draft.lanes,
            [lane]: { ...draft.lanes[lane], status: payload?.error ? 'error' : 'done' }
          }
        }

        // The completion marker is the WORKER's last node, not the agent's.
        draft.currentLane = lane
        enter(
          draft,
          'subagent',
          'subagent',
          `delegated: ${clip(String(payload?.goal || payload?.name || 'subagent'), 22)}`,
          payload?.error ? 'error' : 'done',
          at
        )
        draft.currentLane = 'main'
      })

      return

    case 'error':
      mutate(sid, draft => {
        enter(draft, 'error', 'error', 'failed', 'error', at)
        draft.status = 'error'
        draft.endedAt = at
      })

      return

    default:
      return
  }
}

// ── seeding from the durable trail ─────────────────────────────────────────

function historySidSeeded(sid) {
  return Boolean(trailsMap()[sid]?.seeded)
}

async function seedFromHistory(sid) {
  if (!sid || historySidSeeded(sid)) {
    return
  }

  mutate(sid, draft => {
    draft.seeded = true
  })

  let messages = []

  try {
    const response = await host.request('session.history', { session_id: sid })

    messages = Array.isArray(response?.messages) ? response.messages : []
  } catch {
    return
  }

  const recent = messages.slice(-80)
  let prompt = ''

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === 'user') {
      prompt = clip(firstLine(recent[i]?.display_content ?? recent[i]?.content ?? recent[i]?.text), 160)
      break
    }
  }

  mutate(sid, draft => {
    draft.prompt = prompt || draft.prompt

    // One ordered walk over the previous run: a `state_graph_note` call opens a
    // TASK column and labels everything after it, and each tool row becomes a
    // step in that task's main lane — the same shape the live run builds.
    let noteCursor = ''
    let rowInTask = 0
    let lastStep = ''

    for (const message of recent) {
      if (message?.role !== 'tool' || !message?.name) {
        continue
      }

      if (message.name === NOTE_TOOL) {
        const note = readWorkNote({ name: NOTE_TOOL, args: message.args })

        if (note) {
          noteCursor = note.text
          startTask(draft, note.text, 0)
          rowInTask = 0
        }

        continue
      }

      const key = String(message.tool_call_id || `${message.name}#${draft.cards.length + 1}`)
      const failed = /"error"|^error\b/i.test(clip(firstLine(message?.content), 200))
      const task = describeTask(message.name, message.args, { preview: message?.context })
      const taskId = draft.currentTask || 'T0'
      const stepKey = `${taskId}|main|tool:${message.name}~seed${draft.seq + 1}`

      draft.cards = draft.cards
        .filter(card => card.key !== key)
        .concat([
          {
            key,
            name: message.name,
            task,
            phase: noteCursor,
            turn: 0,
            seeded: true,
            status: failed ? 'error' : 'ok',
            preview: clip(firstLine(message?.context ?? message?.content), 120),
            command: task.command || '',
            args: message?.args,
            result: message?.content,
            error: failed ? clip(firstLine(message?.content), 200) : null,
            diff: '',
            startedAt: 0,
            endedAt: 0,
            durationS: 0
          }
        ])
        .slice(-MAX_CARDS)

      draft.seq += 1

      if (
        touchNode(draft, stepKey, 'tool', taskLabel({ name: message.name, task }), failed ? 'error' : 'ok', 0, '', {
          baseKey: `tool:${message.name}`,
          lane: 'main',
          row: rowInTask,
          taskId
        })
      ) {
        if (lastStep) {
          recordEdge(draft, lastStep, stepKey, 0, '')
        }

        lastStep = stepKey
        rowInTask += 1
      }
    }

    // The last note in the history is the work in progress, so a reloaded pane
    // still opens with the agent's own words rather than a guess.
    draft.lastNode = lastStep || draft.lastNode

    if (noteCursor) {
      draft.workSource = 'agent'
      draft.phase = noteCursor
    }
  })
}

// ── shared formatting helpers ──────────────────────────────────────────────

const durationLabel = card => {
  if (card.status === 'running' || card.status === 'drafting') {
    return 'running'
  }

  if (card.durationS >= 0.05) {
    return card.durationS >= 10 ? `${Math.round(card.durationS)}s` : `${card.durationS.toFixed(1)}s`
  }

  return ''
}

const PATH_KEYS = ['file_path', 'path', 'file', 'notebook_path', 'target_file', 'dir', 'cwd']

function parseArgs(args) {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function pickPath(args) {
  const parsed = parseArgs(args)

  for (const key of PATH_KEYS) {
    const value = parsed[key]

    if (typeof value === 'string' && value.includes('/')) {
      return value
    }
  }

  return ''
}

const basename = path => String(path || '').split('/').filter(Boolean).pop() || ''
const hostOf = value => {
  const first = Array.isArray(value) ? value[0] : value

  try {
    return new URL(String(first)).host
  } catch {
    return clip(String(first || ''), 40)
  }
}

/** The task, not the tool: what the agent was trying to do, in the user's
 *  words. `verb` + `target` are the card's title; `command` is the concrete
 *  thing it fired (command line, path, URL, query) so a run can be traced back. */
function describeTask(name, args, payload) {
  const a = parseArgs(args)
  const file = basename(a.file_path || a.path || a.target_file || a.notebook_path || a.filename)
  const command = (...keys) => {
    for (const key of keys) {
      const value = a[key]

      if (typeof value === 'string' && value) {
        return value
      }
    }

    return ''
  }

  switch (name) {
    case 'terminal':
    case 'process': {
      const cmd = command('command', 'cmd') || firstLine(payload?.preview)

      return { verb: 'Ran', target: clip(cmd, 64), command: cmd }
    }

    case 'execute_code':
      return { verb: 'Ran a script', target: firstLine(a.code), command: firstLine(a.code) }

    case 'read_file':
      return { verb: 'Read', target: file, command: command('file_path', 'path') }

    case 'write_file':
    case 'create_file':
      return { verb: 'Wrote', target: file, command: command('file_path', 'path') }

    case 'patch':
    case 'edit_file':
      return { verb: 'Edited', target: file, command: command('path', 'file_path') }

    case 'search_files':
      return {
        verb: 'Searched for',
        target: clip(command('pattern', 'query'), 40) || 'a pattern',
        command: [a.pattern, a.path].filter(Boolean).join('  in  ')
      }

    case 'web_search':
      return { verb: 'Searched the web for', target: clip(command('query'), 48), command: '' }

    case 'web_extract':
      return { verb: 'Fetched', target: hostOf(a.urls || a.url), command: hostOf(a.urls || a.url) }

    case 'browser_exec':
      return { verb: 'Drove the browser', target: clip(firstLine(a.code), 56), command: '' }

    case 'delegate_task': {
      const first = Array.isArray(a.tasks) ? a.tasks[0] : null

      return {
        verb: 'Delegated to a subagent',
        target: clip(firstLine(first?.goal || a.goal), 48),
        command: ''
      }
    }

    case 'skill_view':
      return { verb: 'Opened skill', target: clip(command('name'), 40), command: '' }

    case 'skill_manage':
      return { verb: 'Updated skill', target: clip(command('name'), 40), command: '' }

    case 'todo_list':
      return { verb: 'Updated the plan', target: '', command: '' }

    case 'memory':
      return { verb: 'Saved a memory note', target: '', command: '' }

    case 'vision_analyze':
      return { verb: 'Looked at an image', target: basename(a.image_url), command: '' }

    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__')

        return { verb: 'Called', target: `${server} · ${rest.join('__')}`, command: '' }
      }

      return { verb: 'Used', target: name, command: '' }
  }
}

/** Args worth SHOWING, in reading order, for the tools whose payload is a
 *  short key/value set. `timeout` is noise on every terminal call, so it comes
 *  last and is dropped when absent — the command is the thing worth reading. */
const ARG_ORDER = ['command', 'timeout']

function argRows(name, args) {
  if (name !== 'terminal' && name !== 'process') {
    return []
  }

  const parsed = parseArgs(args)

  return ARG_ORDER.filter(key => parsed[key] !== undefined && parsed[key] !== null && parsed[key] !== '').map(key => ({
    key,
    value: String(parsed[key])
  }))
}

/** One-line label for a call — the graph node's name. */
const taskLabel = card => {
  const verb = (card.task?.verb || 'Used').toLowerCase()
  const target = card.task?.target || card.name

  return `${verb} ${clip(target, 22)}`.trim()
}

// ── the tool card (interactive) ────────────────────────────────────────────

function ToolCard({ card, expanded, onToggle, onReveal }) {
  const tone = STATUS_TONE[card.status] || 'muted'
  const path = pickPath(card.args)
  const argsText = asText(card.args)
  const resultText = card.error || asText(card.result)
  const hasBody = Boolean(argsText || resultText || card.diff)

  const header = jsxs('button', {
    type: 'button',
    onClick: onToggle,
    className: cn(
      'flex w-full items-start gap-2 px-2 py-1.5 text-left',
      'hover:bg-(--chrome-action-hover)'
    ),
    children: [
      jsx(Codicon, {
        name: expanded ? 'chevron-down' : 'chevron-right',
        className: 'mt-0.5 shrink-0 text-(--ui-text-quaternary)'
      }),
      jsx('span', {
        className: 'mt-1 shrink-0',
        children: jsx(StatusDot, { tone })
      }),
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          jsxs('span', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx('span', {
                className: 'min-w-0 truncate font-medium text-(--ui-text-primary)',
                children: card.task ? `${card.task.verb} ${card.task.target}`.trim() : card.name
              }),
              jsx('span', {
                className: cn(
                  'shrink-0 rounded-[3px] px-1 py-px font-mono text-[0.6rem]',
                  'bg-(--ui-bg-quaternary) text-(--ui-text-quaternary)'
                ),
                children: card.name
              }),
              card.seeded
                ? jsx(Badge, { variant: 'muted', className: 'shrink-0', children: 'history' })
                : null,
              card.turn > 0
                ? jsx('span', {
                    className: 'shrink-0 text-(--ui-text-quaternary)',
                    children: `turn ${card.turn}`
                  })
                : null
            ]
          }),
          card.command || card.preview
            ? jsx('span', {
                className: 'mt-0.5 block truncate font-mono text-(--ui-text-tertiary)',
                children: clip(card.command || card.preview, 96)
              })
            : null
        ]
      }),
      jsx('span', {
        className: 'mt-0.5 shrink-0 text-(--ui-text-quaternary)',
        children: durationLabel(card)
      })
    ]
  })

  if (!expanded) {
    return jsx('div', {
      className: cn(
        'border-b border-(--ui-stroke-quaternary)',
        card.status === 'error' ? 'border-l-2 border-l-(--ui-red)' : 'border-l-2 border-l-transparent'
      ),
      children: header
    })
  }

  // Arg rows for the tools whose payload is a short key/value set: the command
  // gets the full block, everything else (the timeout) is one muted line.
  const argSection = rows =>
    jsxs('div', {
      className: 'mt-1.5',
      children: rows.map(row => {
        if (row.key !== 'command') {
          return jsxs(
            'div',
            {
              className: 'mt-0.5 text-(--ui-text-quaternary)',
              children: [
                `${row.key} `,
                jsx('span', { className: 'font-mono text-(--ui-text-tertiary)', children: clip(row.value, 120) })
              ]
            },
            row.key
          )
        }

        return jsxs(
          'div',
          {
            children: [
              jsx('div', {
                className: 'mb-0.5 text-(--ui-text-quaternary) uppercase tracking-wide',
                children: row.key
              }),
              jsx('pre', {
                className: cn(
                  'max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[3px] p-1.5',
                  'bg-(--ui-bg-quaternary) text-(--ui-text-secondary) font-mono'
                ),
                children: clip(row.value, 4000)
              })
            ]
          },
          row.key
        )
      })
    })

  const section = (title, text, mono) =>
    text
      ? jsxs('div', {
          className: 'mt-1.5',
          children: [
            jsx('div', {
              className: 'mb-0.5 text-(--ui-text-quaternary) uppercase tracking-wide',
              children: title
            }),
            jsx('pre', {
              className: cn(
                'max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[3px] p-1.5',
                'bg-(--ui-bg-quaternary) text-(--ui-text-secondary)',
                mono ? 'font-mono' : ''
              ),
              children: clip(text, 4000)
            })
          ]
        })
      : null

  return jsxs('div', {
    className: cn(
      'border-b border-(--ui-stroke-quaternary)',
      card.status === 'error' ? 'border-l-2 border-l-(--ui-red)' : 'border-l-2 border-l-transparent'
    ),
    children: [
      header,
      jsxs('div', {
        className: 'px-2 pb-2 pl-7',
        children: [
          card.argRows && card.argRows.length ? argSection(card.argRows) : section('args', argsText, true),
          card.error ? section('error', card.error, false) : section('result', resultText, false),
          card.diff ? section('diff', card.diff, true) : null,
          jsxs('div', {
            className: 'mt-1.5 flex flex-wrap items-center gap-2.5',
            children: [
              argsText
                ? jsx(CopyButton, {
                    appearance: 'inline',
                    className: 'text-(--ui-text-tertiary)',
                    label: 'Copy args',
                    text: argsText
                  })
                : null,
              resultText
                ? jsx(CopyButton, {
                    appearance: 'inline',
                    className: 'text-(--ui-text-tertiary)',
                    label: 'Copy result',
                    text: resultText
                  })
                : null,
              path
                ? jsx(Button, {
                    variant: 'text',
                    size: 'inline',
                    onClick: () => onReveal(path),
                    children: 'Reveal file'
                  })
                : null,
              !hasBody
                ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: 'no payload captured' })
                : null
            ]
          })
        ]
      })
    ]
  })
}

// ── the state graph: TASK BANDS x PARALLEL LANES x STEPS (horizontal) ──────
// One horizontal BAND per agent-authored task; its summary card sits at the
// band's left. Inside a band, one ROW per worker (main + every subagent running
// in parallel) and each worker's steps flow left to right. A band's first step
// hangs off the previous band's last step, which is what draws the diagonal,
// labelled connectors this is modelled on. Nothing is inferred: a card's title
// is either the agent's own summary or a concrete activity.

const CELL_W = 226
const STEP_W = 148
const STEP_H = 38
const LANE_ROW_H = 52
const HEADER_W = 168
const HEADER_LEAD = 108
const HEADER_H = 46
const BAND_GAP = 24
const PAD = 14
const EDGE_LABEL_FONT = 9
const LANE_MAX_CELLS = 6
const GAP_W = 70
const GAP_H = 26
const SMIL_STEP = 200 // the 1.2s glide is six 200ms frames
const ARROW_STOP = 8 // dotted layers end this far before the line end (arrow tip at -0.5)

/** Which of the five hop frames the SMIL clock is on for a given event stamp.
 *  The last stamp before `busy` flips false is the frame the march rests on. */
const smilPhase = at => {
  const stamp = Number(at) || 0

  if (!stamp) {
    return 0
  }

  return (Math.floor(stamp / SMIL_STEP) + 1) % 5 * 8
}

/** Node tint per kind — flat fills with white text, the palette the user asked
 *  the graph to follow. */
const KIND_FILL = {
  error: 'var(--ui-red)',
  input: 'var(--ui-yellow)',
  plan: 'var(--ui-cyan)',
  state: 'var(--ui-green)',
  subagent: 'var(--ui-orange)',
  task: 'var(--ui-blue)',
  tool: 'var(--ui-purple)'
}

const cardFill = (kind, dim) =>
  dim ? `color-mix(in srgb, ${KIND_FILL[kind] || 'var(--ui-text-tertiary)'} 42%, var(--ui-bg-primary))` : KIND_FILL[kind] || 'var(--ui-text-tertiary)'

/** Rows shown under the graph for the clicked node: the agent's own words for
 *  the step, plus the tool card's payload when one matches the node's tool.
 *  Nothing is invented — a field is only emitted when the store carries it. */
function nodeDetail(trail, key) {
  const node = trail?.nodes?.[key]

  if (!node) {
    return null
  }

  const rows = []

  if (node.summary) {
    rows.push({ label: 'task', value: node.summary })
  }

  if (node.name) {
    rows.push({ label: 'step', value: node.name })
  }

  const toolName = String(node.baseKey || '').startsWith('tool:')
    ? String(node.baseKey).slice(5)
    : ''
  const card = toolName
    ? (trail.cards || []).filter(item => item.name === toolName).slice(-1)[0]
    : null

  if (card) {
    if (card.command) {
      rows.push({ label: 'command', value: clip(card.command, 4000), mono: true })
    }

    const extras = (card.argRows || [])
      .filter(row => row.key !== 'command')
      .map(row => `${row.key} ${clip(String(row.value), 120)}`)
      .join('  ·  ')

    if (extras) {
      rows.push({ label: 'other args', value: extras })
    }

    const body = card.error || asText(card.result)

    if (body) {
      rows.push({ label: 'result', value: clip(String(body), 1200), mono: true })
    }

    if (card.status) {
      rows.push({ label: 'status', value: card.status })
    }

    if (card.durationS) {
      rows.push({ label: 'took', value: durationLabel(card) })
    }
  }

  if (node.count > 1) {
    rows.push({ label: 'repeats', value: `x${node.count}` })
  }

  return rows.length ? { title: toolName || node.kind || key, rows } : null
}

/** Wrap a title into at most two lines for a card. */
function wrapTitle(text, maxChars = 20, maxLines = 2) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()

  if (!raw) {
    return []
  }

  const words = raw.split(' ')
  const lines = []
  let line = ''

  for (const word of words) {
    if (!line) {
      line = word
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }

    if (lines.length === maxLines) {
      break
    }
  }

  if (line && lines.length < maxLines) {
    lines.push(line)
  }

  const shown = lines.join(' ').length

  if (shown < raw.length && lines.length) {
    lines[lines.length - 1] = `${clip(lines[lines.length - 1], Math.max(4, maxChars - 1))}…`
  }

  return lines.slice(0, maxLines)
}

/** HUMAN transition verbs for the connectors. */
const TRANSITION_LABELS = {
  'message.start': 'answers',
  'message.delta': 'streams',
  'thinking.delta': 'thinks',
  'reasoning.delta': 'reasons',
  'reasoning.available': 'reasons',
  'tool.generating': 'drafts call',
  'tool.start': 'calls tool',
  'tool.progress': 'tool runs',
  'tool.complete': 'tool returns',
  'subagent.spawn_requested': 'spawns',
  'subagent.start': 'starts subagent',
  'subagent.tool': 'subagent runs',
  'subagent.complete': 'subagent done',
  'todo.updated': 'plans',
  'clarify.request': 'asks user',
  'approval.request': 'asks approval',
  'secret.request': 'asks secret',
  'status.update': 'compacts',
  error: 'fails',
  'message.complete': 'answers'
}

/** Lay the trail out as horizontal task bands. Deterministic arithmetic only —
 *  safe to run during render, no measurement. */
function layoutGraph(trail, openLanes) {
  const steps = trail.order.map(key => trail.nodes[key]).filter(Boolean)
  const openSet = openLanes instanceof Set ? openLanes : new Set()
  // Global arrival order. `step.row` is a LANE-local index, so it cannot tell
  // us which node preceded a branch — this can.
  const seqOf = new Map(trail.order.map((key, index) => [key, index]))
  const tasks = []
  const seen = new Set()

  const addTask = (id, text, at) => {
    if (!id || seen.has(id)) {
      return
    }

    seen.add(id)
    tasks.push({ id, text: text || '', at: at || 0, lanes: [] })
  }

  for (const task of trail.tasks || []) {
    addTask(task.id, task.text, task.at)
  }

  // Steps taken before the agent named any task live in a header-less band.
  for (const step of steps) {
    addTask(step.taskId || 'T0', '', -1)
  }

  tasks.sort((a, b) => a.at - b.at)

  const kept = tasks.filter(task => steps.some(step => (step.taskId || 'T0') === task.id))
  tasks.length = 0
  tasks.push(...kept)

  const positions = {}
  let y = PAD
  let width = 0

  for (const task of tasks) {
    const own = steps.filter(step => (step.taskId || 'T0') === task.id)
    const laneIds = []

    for (const step of own) {
      const lane = step.lane || 'main'

      if (!laneIds.includes(lane)) {
        laneIds.push(lane)
      }
    }

    laneIds.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : laneIds.indexOf(a) - laneIds.indexOf(b)))

    // Cells for a lane. A long lane collapses the stretches it hides into `… N`
    // chips — but never the structure: the first step, the last
    // LANE_MAX_CELLS-1, the step the agent is on, and any step a branch forks
    // off stay visible, so a lane reads
    //     [a] -> … -> [h] -> … -> [z]
    //              +-> [c1] -> … -> [h1]
    // with the branch hanging off the card you can actually see.
    const arrival = (a, b) => (a.row ?? 0) - (b.row ?? 0)
    const laneStepsOf = id => own.filter(step => (step.lane || 'main') === id).sort(arrival)

    const buildCells = (laneSteps, pinned) => {
      const cells = []
      const tailStart = Math.max(0, laneSteps.length - (LANE_MAX_CELLS - 1))
      const keep = new Set()

      laneSteps.forEach((step, index) => {
        if (index === 0 || index >= tailStart || pinned.has(step.key)) {
          keep.add(index)
        }
      })

      let run = null

      const flush = () => {
        if (run) {
          cells.push({ type: 'gap', hidden: run.count, fromSeq: run.fromSeq, toSeq: run.toSeq })
          run = null
        }
      }

      laneSteps.forEach((step, index) => {
        if (keep.has(index)) {
          flush()
          cells.push({ type: 'step', step })

          return
        }

        const seq = num(seqOf.get(step.key))

        if (run) {
          run.count += 1
          run.toSeq = seq
        } else {
          run = { count: 1, fromSeq: seq, toSeq: seq }
        }
      })

      flush()

      return cells
    }

    // Which node each branch hangs off: the last main-lane step that preceded
    // it in arrival order. Those nodes are pinned so the fork attaches to a real
    // card rather than to a `… N` chip.
    const mainSteps = laneStepsOf('main')
    const forkSource = new Map()
    const pinnedForks = new Set()

    for (const id of laneIds) {
      if (id === 'main') {
        continue
      }

      const firstSeq = seqOf.get(laneStepsOf(id)[0]?.key)
      let source = null

      for (const step of mainSteps) {
        const seq = seqOf.get(step.key)

        if (Number.isFinite(firstSeq) && Number.isFinite(seq) && seq < firstSeq) {
          source = step
        }
      }

      if (source) {
        forkSource.set(id, source.key)
        pinnedForks.add(source.key)
      }
    }

    const lanes = laneIds.map((id, laneIdx) => {
      const steps = laneStepsOf(id)
      const isOpen = openSet.has(`${task.id}|${id}`)
      const elidable = steps.length > LANE_MAX_CELLS
      const pinned = new Set(id === 'main' ? [...pinnedForks, trail.current] : [trail.current])
      const spelledOut = steps.map(step => ({ type: 'step', step }))
      const cells = isOpen
        ? elidable
          ? [...spelledOut, { type: 'collapse', hidden: steps.length - LANE_MAX_CELLS }]
          : spelledOut
        : buildCells(steps, pinned)

      return {
        id,
        label: id === 'main' ? '' : clip(String(trail.lanes?.[id]?.label || id).replace(/\s+/g, ' '), 26),
        laneIdx,
        rows: steps.length,
        cells,
        steps,
        // Set below: the column this lane's first cell starts at, and the point
        // it fans out from.
        forkCol: 0,
        forkFrom: null
      }
    })

    task.header = { h: HEADER_H, w: HEADER_W, x: PAD, y: y + 4 }
    task.overflow = Math.max(0, own.length - lanes.reduce((sum, lane) => sum + lane.cells.length, 0))
    task.hasHeader = Boolean(task.text)
    task.lanes = lanes
    task.y = y

    const colX = col => PAD + HEADER_W + HEADER_LEAD + col * CELL_W

    for (const lane of lanes) {
      lane.y = num(y + 4 + lane.laneIdx * LANE_ROW_H)
    }

    // Columns are GLOBAL to the band: a branch starts one cell to the RIGHT of
    // the node it forked off, so two branches off the same node line up under
    // each other instead of every branch restarting at the band header.
    lanes[0]?.cells.forEach((cell, col) => {
      cell.col = num(col)
    })

    for (let i = 1; i < lanes.length; i++) {
      const lane = lanes[i]
      const key = forkSource.get(lane.id)
      const source =
        lanes[0]?.cells.find(cell => cell.type === 'step' && cell.step.key === key) ||
        lanes[0]?.cells[lanes[0].cells.length - 1]

      lane.forkCol = num(source ? source.col + 1 : 0)
      lane.cells.forEach((cell, col) => {
        cell.col = num(lane.forkCol + col)
      })
    }

    for (const lane of lanes) {
      for (const cell of lane.cells) {
        if (cell.type !== 'step') {
          continue
        }

        positions[cell.step.key] = { x: num(colX(cell.col)), y: lane.y }
      }
    }

    // Where each fan-out connector starts: the right edge of the node that
    // spawned the branch, and the x it drops down at.
    const mainLane = lanes[0]

    for (let i = 1; i < lanes.length; i++) {
      const lane = lanes[i]
      const col = (lane.forkCol ?? 0) - 1
      const source = mainLane?.cells.find(cell => cell.col === col)

      if (!source) {
        continue
      }

      const box =
        source.type === 'gap'
          ? {
              x: num(colX(col) + (STEP_W - GAP_W) / 2),
              y: num(mainLane.y + (STEP_H - GAP_H) / 2),
              w: GAP_W,
              h: GAP_H
            }
          : positions[source.step?.key] && {
              x: positions[source.step.key].x,
              y: positions[source.step.key].y,
              w: STEP_W,
              h: STEP_H
            }

      if (box) {
        lane.forkFrom = {
          x: num(box.x + box.w),
          y: num(box.y + box.h / 2),
          elbow: num(box.x + box.w + 14)
        }
      }
    }

    const tallest = Math.max(1, lanes.length)
    const lastCol = Math.max(0, ...lanes.map(lane => (lane.forkCol ?? 0) + Math.max(0, lane.cells.length - 1)))

    task.height = tallest * LANE_ROW_H
    width = Math.max(width, PAD + HEADER_W + HEADER_LEAD + lastCol * CELL_W + STEP_W + PAD)
    y += task.height + BAND_GAP
  }

  return { tasks, positions, width: Math.max(width, 320), height: Math.max(y - BAND_GAP + PAD, 120) }
}

function GraphView({ trail }) {
  const scroller = useRef(null)
  const openLanes = useValue($expandedLanes)
  const openSet = new Set(
    Object.keys(openLanes)
      .filter(key => key.startsWith(`${trail?.sid}:`))
      .map(key => key.slice(String(trail?.sid).length + 1))
  )
  const layout = trail && trail.order.length ? layoutGraph(trail, openSet) : null

  const onToggleLane = (taskId, laneId) => {
    const key = `${trail?.sid}:${taskId}|${laneId}`
    const next = { ...$expandedLanes.get() }

    if (next[key]) {
      delete next[key]
    } else {
      next[key] = true
    }

    $expandedLanes.set(next)
  }
  const focus = (trail && trail.current) || ''
  // A finished turn is a STILL frame: the halo and the marching dots belong to
  // the in-flight step only, so they must drop out once the run reports done.
  const live = trail?.status === 'running' || trail?.status === 'drafting' || Boolean(trail && !trail.endedAt)

  useEffect(() => {
    const el = scroller.current
    const pos = layout ? layout.positions[focus] : null

    if (!el || !pos) {
      return
    }

    el.scrollTo({
      left: Math.max(0, pos.x - el.clientWidth / 2.5),
      top: Math.max(0, pos.y - el.clientHeight / 2),
      behavior: 'smooth'
    })
  }, [focus])

  if (!layout) {
    return jsx('div', {
      className: 'p-3',
      children: jsx(EmptyState, {
        title: 'No agent work yet',
        description: 'Send a prompt — the graph paints itself from the live gateway event stream.'
      })
    })
  }

  const { tasks, positions, width, height } = layout
  const children = []
  const markerId = `sg-arrow-${String(trail.sid || 'x').replace(/[^a-zA-Z0-9]/g, '')}`

  // A card: flat tinted fill, white title, optional halo for the live step.
  const card = ({ key, x, y: cardY, w, h, title, kind, dim, halo, meta, centered, role = 'step' }) => {
    const lines = wrapTitle(title, Math.floor(w / 6.4), 2)
    const firstBaseline = cardY + h / 2 - (lines.length - 1) * 6 + 3.5

    if (halo) {
      children.push(
        jsxs(
          'rect',
          {
            className: 'sg-halo',
            x: x - 5,
            y: cardY - 5,
            width: w + 10,
            height: h + 10,
            rx: 9,
            fill: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)',
            children: jsx(
              'animate',
              {
                attributeName: 'opacity',
                fill: 'freeze',
                values: '0.55;1;0.55',
                dur: '1.6s',
                repeatCount: 'indefinite'
              },
              `${key}:pulse`
            )
          },
          `${key}:halo`
        )
      )
    }

    children.push(
      jsx(
        'rect',
        {
          className: role === 'task' ? 'sg-task' : 'sg-node',
          x,
          y: cardY,
          width: w,
          height: h,
          rx: 8,
          fill: cardFill(kind, dim),
          opacity: dim ? 0.85 : 1
        },
        `${key}:rect`
      )
    )

    lines.forEach((line, index) => {
      children.push(
        jsx(
          'text',
          {
            className: role === 'task' ? 'sg-task-label' : 'sg-activity',
            x: centered ? x + w / 2 : x + 9,
            y: firstBaseline + index * 12,
            fontSize: 10,
            fontWeight: 600,
            textAnchor: centered ? 'middle' : 'start',
            fill: '#fff',
            opacity: dim ? 0.85 : 0.96,
            children: line
          },
          `${key}:line${index}`
        )
      )
    })

    if (role === 'step') {
      children.push(
        jsx(
          'rect',
          {
            className: 'sg-hit',
            x,
            y: cardY,
            width: w,
            height: h,
            rx: 8,
            fill: 'transparent',
            onClick: event => {
              event.stopPropagation()
              $detail.set(`${trail?.sid}:${key}`)
            },
            style: { cursor: 'pointer' },
            children: jsx('title', { children: title }, `${key}:tip`)
          },
          `${key}:hit`
        )
      )
    }

    if (meta) {
      children.push(
        jsx(
          'text',
          {
            className: 'sg-task-meta',
            x: centered ? x + w / 2 : x + 9,
            y: cardY + h - 6,
            fontSize: 8.5,
            textAnchor: centered ? 'middle' : 'start',
            fill: '#fff',
            opacity: 0.6,
            children: meta
          },
          `${key}:meta`
        )
      )
    }

    return lines
  }

  // A connector between two explicit points, with its verb written along the
  // line (the diagonal, rotated labels the design follows).
  const connector = (sx, sy, tx, ty, label, active, key, elbowAt) => {
    sx = num(sx)
    sy = num(sy)
    tx = num(tx)
    ty = num(ty)

    // A fan-out draws an elbow (`+->`): out of the node, down, then into the
    // branch's first card — a straight diagonal would read as a chain link.
    const elbow = Number.isFinite(elbowAt)
    const d = elbow ? `M ${sx} ${sy} H ${num(elbowAt)} V ${ty} H ${tx}` : `M ${sx} ${sy} L ${tx} ${ty}`
    // The dotted layers stop short of the arrowhead (its tip sits at tx-0.5),
    // so a dot never rides across the triangle.
    const dDots = elbow
      ? `M ${sx} ${sy} H ${num(elbowAt)} V ${ty} H ${num(Math.max(sx, tx - ARROW_STOP))}`
      : `M ${sx} ${sy} L ${num(Math.max(sx, tx - ARROW_STOP))} ${ty}`

    const dx = tx - sx
    const dy = ty - sy
    const length = Math.hypot(dx, dy)
    // Deterministic resting frame so the march freezes at a sane spot once the
    // stream goes idle (busy flips false): the last event's timestamp decides it.
    const phase = smilPhase(latestAt)
    // Fixed descending ladder: linear interpolation of a monotone list walks at
    // a constant rate (offset 40 -> 0 == the dot advancing 0 -> 40 along the
    // line), and repeats with exactly one wrap. A phase-rotated list would
    // inject a +32 backward slide at its seam.
    const ladder = '40;32;24;16;8;0'
    const stroke = active ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'

    children.push(
      jsxs(
        'path',
        {
          className: elbow ? 'sg-edge sg-edge-fork' : 'sg-edge',
          d: active ? dDots : d,
          fill: 'none',
          stroke,
          strokeWidth: active ? 2.4 : 1.6,
          opacity: active ? 1 : 0.75,
          markerEnd: `url(#${active ? `${markerId}-on` : markerId})`,
          ...(active
            ? {
                strokeDasharray: '0.1 7',
                strokeLinecap: 'round',
                strokeDashoffset: 8
              }
            : {})
        },
        `${key}:path`
      )
    )

    // The fat dot: one accent dot every 5 slots (period 40 = 5x8), hopping
    // one slot per step (discrete) so the run reads  · · o · · >  ->  · · · o · >
    // while the small dots stay put.
    if (active) {
      children.push(
        jsxs(
          'path',
          {
            className: 'sg-edge sg-edge-dot',
            d: dDots,
            fill: 'none',
            stroke: 'var(--ui-accent)',
            strokeWidth: 4.2,
            strokeLinecap: 'round',
            strokeDasharray: '0.1 39',
            strokeDashoffset: phase,
            opacity: 1,
            children: jsx(
              'animate',
              {
                attributeName: 'stroke-dashoffset',
                fill: 'freeze',
                values: ladder,
                calcMode: 'linear',
                dur: '1s',
                repeatCount: 'indefinite'
              },
              `${key}:hop`
            )
          },
          `${key}:dot`
        )
      )
    }

    const text = clip(String(label || ''), 22)

    if (elbow || !text || length < 72) {
      return
    }

    let angle = num((Math.atan2(dy, dx) * 180) / Math.PI)

    if (angle > 90) {
      angle -= 180
    } else if (angle < -90) {
      angle += 180
    }

    const mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 }
    const norm = Math.max(1, length)

    children.push(
      jsx(
        'text',
        {
          className: 'sg-edge-label',
          transform: `translate(${mid.x - (dy / norm) * 8} ${mid.y + (dx / norm) * 8}) rotate(${angle})`,
          fontSize: EDGE_LABEL_FONT,
          textAnchor: 'middle',
          fill: active ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)',
          children: text
        },
        `${key}:label`
      )
    )
  }

  // Anchor points for the two card shapes a lane can hold.
  const stepOut = pos => ({ x: pos.x + STEP_W, y: pos.y + STEP_H / 2 })
  const stepIn = pos => ({ x: pos.x - 2, y: pos.y + STEP_H / 2 })
  const gapOut = (lane, col) => ({
    x: PAD + HEADER_W + HEADER_LEAD + col * CELL_W + (STEP_W - GAP_W) / 2 + GAP_W,
    y: lane.y + (STEP_H - GAP_H) / 2 + GAP_H / 2
  })
  const gapIn = (lane, col) => ({
    x: PAD + HEADER_W + HEADER_LEAD + col * CELL_W + (STEP_W - GAP_W) / 2 - 6,
    y: lane.y + (STEP_H - GAP_H) / 2 + GAP_H / 2
  })
  const headerOut = header => ({ x: header.x + header.w, y: header.y + header.h / 2 })

  // The `… N` cell that stands in for an elided middle of a lane.
  // The elision chip. Clickable: it opens the lane's hidden middle, and when
  // open the same chip (at the end of the lane) closes it again.
  const chipCard = (lane, col, lines, key, onToggle, hint, extraClass) => {
    const x = PAD + HEADER_W + HEADER_LEAD + col * CELL_W + (STEP_W - GAP_W) / 2
    const y = lane.y + (STEP_H - GAP_H) / 2

    children.push(
      jsxs(
        'g',
        {
          className: `sg-chip ${extraClass || ''}`.trim(),
          onClick: event => {
            event.stopPropagation()
            onToggle()
          },
          style: { cursor: 'pointer' },
          children: [
            jsx(
              'rect',
              {
                className: extraClass === 'sg-collapse' ? 'sg-collapse' : 'sg-gap',
                x,
                y,
                width: GAP_W,
                height: GAP_H,
                rx: 7,
                fill: 'var(--ui-bg-quaternary)',
                stroke: 'var(--ui-stroke-secondary)'
              },
              `${key}:rect`
            ),
            jsx('title', { children: hint }, `${key}:hint`),
            ...(lines || []).map((text, index) =>
              jsx(
                'text',
                {
                  className:
                    index === 0
                      ? `sg-chip-top ${extraClass || ''}`.trim()
                      : extraClass === 'sg-collapse'
                        ? 'sg-collapse-label'
                        : 'sg-gap-label',
                  x: x + GAP_W / 2,
                  y: num(y + (index === 0 ? 10 : 22)),
                  fontSize: index === 0 ? 7 : 9.5,
                  textAnchor: 'middle',
                  fill: index === 0 ? 'var(--ui-text-quaternary)' : 'var(--ui-text-tertiary)',
                  children: text
                },
                `${key}:line${index}`
              )
            )
          ]
        },
        key
      )
    )

    return { x, y }
  }

  children.push(
    jsx(
      'defs',
      {
        children: ['sg-arrow', 'sg-arrow-on'].map(suffix =>
          jsx(
            'marker',
            {
              id: suffix === 'sg-arrow' ? markerId : `${markerId}-on`,
              markerWidth: 8,
              markerHeight: 8,
              refX: 6,
              refY: 3,
              orient: 'auto',
              markerUnits: 'userSpaceOnUse',
              children: jsx('path', {
                d: 'M0,0 L6,3 L0,6 z',
                fill: suffix === 'sg-arrow' ? 'var(--ui-stroke-tertiary)' : 'var(--ui-accent)'
              })
            },
            suffix
          )
        )
      },
      'defs'
    )
  )

  let previousTail = null

  for (const task of tasks) {
    const hasHeader = task.hasHeader

    if (hasHeader) {
      const stepCount = task.lanes.reduce((sum, lane) => sum + lane.steps.length, 0)

      card({
        key: `${task.id}:header`,
        x: task.header.x,
        y: task.header.y,
        w: task.header.w,
        h: task.header.h,
        title: task.text,
        kind: 'task',
        centered: true,
        role: 'task',
        meta: task.lanes.length > 1 ? `${stepCount} steps · ${task.lanes.length} in parallel` : `${stepCount} steps`
      })
    }

    for (const lane of task.lanes) {
      lane.y = task.y + 4 + lane.laneIdx * LANE_ROW_H

      if (lane.label) {
        children.push(
          jsx(
            'text',
            {
              className: 'sg-lane-label',
              x: task.header.x + 2,
              y: lane.y + 12,
              fontSize: 8.5,
              fill: 'var(--ui-text-quaternary)',
              children: `⇉ ${lane.label}`
            },
            `${task.id}:${lane.id}:lane`
          )
        )
      }

      // Walk the lane's cells in order — each cell is either a step or the gap
      // that stands for the elided middle — and connect consecutive ones.
      let previousPoint = null
      let previousKey = ''

      lane.cells.forEach((cell, idx) => {
        const col = cell.col ?? idx

        if (cell.type === 'gap' || cell.type === 'collapse') {
          const isOpen = cell.type === 'collapse'

          chipCard(
            lane,
            col,
            isOpen
              ? ['click to collapse', `\u25b4 ${cell.hidden}`]
              : ['click to show all', `\u2026 ${cell.hidden}`],
            `${task.id}:${lane.id}:chip:${col}`,
            () => onToggleLane(task.id, lane.id),
            isOpen
              ? `collapse the ${cell.hidden} steps this lane spelled out`
              : `click to show all ${cell.hidden} hidden steps`,
            isOpen ? 'sg-collapse' : 'sg-gap'
          )

          if (previousPoint) {
            connector(previousPoint.sx, previousPoint.sy, gapIn(lane, col).x, gapIn(lane, col).y, '', false, `${task.id}:${lane.id}:gapin:${col}`)
          }

          previousPoint = { sx: gapOut(lane, col).x, sy: gapOut(lane, col).y }
          previousKey = ''

          return
        }

        const step = cell.step
        const pos = positions[step.key]

        if (!pos) {
          return
        }

        const isCurrent = live && trail.current === step.key

        if (previousPoint) {
          const via = previousKey ? trail.edges[`${previousKey}>${step.key}`]?.via : ''

          connector(previousPoint.sx, previousPoint.sy, stepIn(pos).x, stepIn(pos).y, via || '', isCurrent, `${step.key}:chain`)
        } else if (lane.forkFrom) {
          // Fan-out: this branch hangs off the node that spawned it.
          connector(
            lane.forkFrom.x,
            lane.forkFrom.y,
            stepIn(pos).x,
            stepIn(pos).y,
            '',
            isCurrent,
            `${step.key}:fork`,
            lane.forkFrom.elbow
          )
        } else if (col === 0 && hasHeader) {
          // Band head -> this lane's first cell: the diagonal that gives the
          // graph its shape.
          connector(
            headerOut(task.header).x,
            headerOut(task.header).y,
            stepIn(pos).x,
            stepIn(pos).y,
            trail.edges[`${task.id}:header>${step.key}`]?.via || '',
            isCurrent,
            `${step.key}:entry`
          )
        } else if (previousTail && positions[previousTail]) {
          const tail = positions[previousTail]

          connector(stepOut(tail).x, stepOut(tail).y, stepIn(pos).x, stepIn(pos).y, '', isCurrent, `${step.key}:entry`)
        }

        previousPoint = { sx: stepOut(pos).x, sy: stepOut(pos).y }
        previousKey = step.key
      })
    }

    // First step of each lane, so the band's back-reference edge can be drawn.
    const firsts = task.lanes.map(lane => lane.steps[0]).filter(Boolean)

    previousTail = firsts.length ? firsts[0].key : previousTail

    for (const lane of task.lanes) {
      for (const step of lane.steps) {
        const pos = positions[step.key]

        if (!pos) {
          continue
        }

        const isCurrent = live && trail.current === step.key

        card({
          key: step.key,
          x: pos.x,
          y: pos.y,
          w: STEP_W,
          h: STEP_H,
          halo: isCurrent,
          kind: step.kind,
          dim: false,
          title: step.name,
          centered: true
        })
      }
    }
  }

  const selected = useValue($detail)
  const openKey = selected && selected.startsWith(`${trail?.sid}:`)
    ? selected.slice(String(trail?.sid).length + 1)
    : ''
  const detail = openKey ? nodeDetail(trail, openKey) : null

  const close = () => $detail.set('')

  return jsxs('div', {
    // clicking the empty canvas area behind the boxes dismisses the detail box
    onClick: close,
    className: 'flex min-h-0 flex-1 flex-row gap-1',
    children: [
      jsx('div', {
        ref: scroller,
        className: 'min-h-0 min-w-0 flex-1 overflow-auto p-2',
        children: jsx('svg', {
          width,
          height,
          viewBox: `0 0 ${width} ${height}`,
          role: 'img',
          children
        })
      }),
      detail
        ? jsxs('div', {
            onClick: event => event.stopPropagation(),
            className: 'w-[260px] shrink-0 self-start overflow-auto rounded-[4px] border border-(--ui-stroke-quaternary) bg-(--ui-bg-secondary) px-2 py-1.5',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-1.5',
                children: [
                  jsx('span', {
                    className: 'min-w-0 flex-1 truncate font-medium text-(--ui-text-primary)',
                    children: detail.title
                  }),
                  jsx('span', {
                    className: 'shrink-0 rounded-[3px] px-1 py-px font-mono text-[0.6rem] bg-(--ui-bg-quaternary) text-(--ui-text-quaternary)',
                    children: `step ${trail.order.indexOf(openKey) + 1}/${trail.order.length}`
                  }),
                  jsx('button', {
                    type: 'button',
                    onClick: close,
                    title: 'close',
                    className: 'shrink-0 rounded-[3px] px-1 font-mono text-[0.65rem] text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover)',
                    children: '[x]'
                  })
                ]
              }),
              jsx('div', {
                className: 'mt-1 flex flex-col gap-0.5',
                children: detail.rows.map(row =>
                  jsxs(
                    'div',
                    {
                      className: 'flex items-baseline gap-1.5',
                      children: [
                        jsx('span', {
                          className: 'w-14 shrink-0 text-(--ui-text-quaternary) uppercase tracking-wide',
                          children: row.label
                        }),
                        jsx(row.mono ? 'pre' : 'span', {
                          className: row.mono
                            ? 'min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-(--ui-text-secondary)'
                            : 'min-w-0 flex-1 break-all text-(--ui-text-secondary)',
                          children: row.value
                        })
                      ]
                    },
                    row.label
                  )
                )
              })
            ]
          })
        : null
    ]
  })
}

// ── the audit trail (interactive cards) ────────────────────────────────────

function TrailView({ trail, sid, ctx }) {
  const filter = useValue($filter)
  const expanded = useValue($expanded)
  const cards = trail ? trail.cards : []
  const scoped =
    filter === 'turn'
      ? cards.filter(card => card.turn === (trail?.turn ?? 0) && !card.seeded)
      : filter === 'failed'
        ? cards.filter(card => card.status === 'error')
        : cards

  if (!scoped.length) {
    return jsx('div', {
      className: 'p-3',
      children: jsx(EmptyState, {
        title: filter === 'failed' ? 'No failed tool calls' : 'No tool calls captured',
        description:
          filter === 'turn'
            ? 'This turn has not called a tool yet.'
            : 'Tool calls land here live, straight from the gateway event stream.'
      })
    })
  }

  const rows = []
  let previousPhase = null

  for (let i = scoped.length - 1; i >= 0; i -= 1) {
    const card = scoped[i]
    const key = `${sid}:${card.key}`

    // A new work summary opens a group — the agent's own words for what the
    // cards underneath belong to.
    if (card.phase && card.phase !== previousPhase) {
      rows.push(
        jsx(
          'div',
          {
            className: cn(
              'flex items-center gap-1.5 px-2 pt-2 pb-1 text-(--ui-text-quaternary)',
              i === scoped.length - 1 ? 'pt-1' : ''
            ),
            children: [
              jsx(Codicon, { name: 'chevron-right' }),
              jsx('span', { className: 'truncate text-(--ui-text-primary)', children: clip(card.phase, 60) })
            ]
          },
          `${key}:phase`
        )
      )
    }

    previousPhase = card.phase || previousPhase

    rows.push(
      jsx(
        'div',
        {
          className: cn(
            'px-1 text-(--ui-text-secondary)',
            i === 0 ? 'pt-0' : ''
          ),
          children: jsx(ToolCard, {
            card,
            expanded: Boolean(expanded[key]),
            onToggle: () => {
              const all = $expanded.get()

              $expanded.set({ ...all, [key]: !all[key] })
            },
            onReveal: path => {
              void ctx.os.revealPath(path)
            }
          })
        },
        key
      )
    )
  }

  return jsx(ScrollArea, { className: 'min-h-0 flex-1', children: jsx('div', { children: rows }) })
}

// ── the pane ───────────────────────────────────────────────────────────────

function Chip({ active, onClick, children }) {
  return jsx('button', {
    type: 'button',
    onClick,
    className: cn(
      'rounded-[3px] px-1.5 py-0.5 text-[0.6875rem] leading-4',
      active
        ? 'bg-(--ui-control-active-background) text-(--ui-text-primary)'
        : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
    ),
    children
  })
}

function Legend({ trail }) {
  const states = trail ? trail.order.filter(key => trail.nodes[key]) : []
  const kinds = new Set(states.map(key => trail.nodes[key].kind))
  const items = [...kinds].filter(kind => KIND_LABELS[kind])

  if (!items.length) {
    return null
  }

  return jsx('div', {
    className: 'flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-quaternary) px-2 py-1 text-(--ui-text-quaternary)',
    children: items.map(kind =>
      jsxs(
        'span',
        {
          className: 'inline-flex items-center gap-1',
          children: [
            jsx('span', {
              className: 'inline-block size-1.5 rounded-full',
              style: { background: kindColor(kind) }
            }),
            jsx('span', { children: KIND_LABELS[kind] })
          ]
        },
        kind
      )
    )
  })
}

function StateGraphPane({ ctx }) {
  const trails = useValue($trails)
  const view = useValue($view)
  const filter = useValue($filter)
  const follow = useValue($follow)
  const pinned = useValue($pinned)
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const busy = useValue(host.state.busy)
  const sid = follow ? focused || active || '' : pinned
  const trail = sid ? trails[sid] : null

  const current = trail?.nodes?.[trail.current]
  const mode = modeOf(trail)
  const tools = trail ? trail.cards.filter(card => !card.seeded).length : 0
  const history = trail ? trail.cards.filter(card => card.seeded).length : 0
  const failed = trail ? trail.cards.filter(card => card.status === 'error').length : 0
  const doing = trail?.drafting
    ? `preparing ${trail.drafting}`
    : trail?.phase
      ? clip(trail.phase, 48)
      : current
        ? clip(current.name, 48)
        : sid
          ? 'idle'
          : 'no session'

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col text-xs text-(--ui-text-secondary)',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-stroke-quaternary) px-2 py-1.5',
        children: [
          busy ? jsx(GlyphSpinner, { className: 'shrink-0' }) : null,
          jsx(Badge, { variant: mode.variant, className: 'shrink-0', children: mode.label }),
          jsxs('span', {
            className: 'min-w-0 flex-1 truncate text-(--ui-text-primary)',
            children: doing
          }),
          jsx(Tip, {
            label: trail?.prompt ? `Prompt: ${trail.prompt}` : 'The focused chat drives this pane',
            children: jsx('span', {
              className: 'shrink-0 text-(--ui-text-quaternary)',
              children: [
                `${tools} live`,
                history ? ` · ${history} history` : '',
                failed ? ` · ${failed} failed` : ''
              ].join('')
            })
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-1 border-b border-(--ui-stroke-quaternary) px-1.5 py-1',
        children: [
          jsx(Chip, { active: view === 'graph', onClick: () => $view.set('graph'), children: 'graph' }),
          jsx(Chip, { active: view === 'trail', onClick: () => $view.set('trail'), children: 'trail' }),
          jsx('span', { className: 'mx-1 h-3 w-px bg-(--ui-stroke-quaternary)' }),
          jsx(Chip, { active: follow, onClick: () => $follow.set(true), children: 'follow' }),
          jsx(Chip, {
            active: !follow,
            onClick: () => {
              $pinned.set(!follow ? sid : focused || active || '')
              $follow.set(false)
            },
            children: 'pin'
          }),
          jsx('span', { className: 'flex-1' }),
          jsx(Button, {
            variant: 'ghost',
            size: 'xs',
            onClick: () =>
              mutate(sid, draft => {
                draft.order = []
                draft.nodes = {}
                draft.edges = {}
                draft.cards = []
                draft.current = ''
                draft.previous = ''
              }),
            children: 'reset'
          })
        ]
      }),
      view === 'graph'
        ? jsx(GraphView, { trail })
        : jsxs('div', {
            className: 'flex min-h-0 flex-1 flex-col',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-1 px-1.5 py-1',
                children: [
                  jsx(Chip, { active: filter === 'all', onClick: () => $filter.set('all'), children: 'all' }),
                  jsx(Chip, { active: filter === 'turn', onClick: () => $filter.set('turn'), children: 'this turn' }),
                  jsx(Chip, { active: filter === 'failed', onClick: () => $filter.set('failed'), children: 'failed' })
                ]
              }),
              jsx(TrailView, { trail, sid, ctx })
            ]
          }),
      jsx(Legend, { trail }),
      jsx('div', {
        className: 'border-t border-(--ui-stroke-quaternary) px-2 py-1 text-(--ui-text-quaternary)',
        children: sid ? clip(sid, 27) : 'waiting for a focused session'
      })
    ]
  })
}

// ── statusbar chip ─────────────────────────────────────────────────────────

function StateChip({ ctx }) {
  const trails = useValue($trails)
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const busy = useValue(host.state.busy)
  const sid = focused || active || ''
  const trail = sid ? trails[sid] : null
  const current = trail?.nodes?.[trail.current]
  const mode = modeOf(trail)
  const doing = trail?.drafting ? `preparing ${trail.drafting}` : clip(trail?.phase || current?.name || '', 34)
  const label = doing || mode.label.toLowerCase()

  return jsx(Tip, {
    label: `${PLUGIN_ID}: ${trail ? trail.cards.length : 0} tool call(s) captured for ${sid || 'no session'}`,
    children: jsxs('span', {
      className: 'inline-flex h-full cursor-default items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: [
        jsx('span', { className: 'inline-block size-1.5 rounded-full', style: { background: kindColor(current?.kind || 'state') } }),
        jsx('span', { children: label }),
        busy ? jsx(GlyphSpinner, {}) : null
      ]
    })
  })
}

// ── inline transcript directives ───────────────────────────────────────────

function DirectiveFrame({ title, children }) {
  return jsxs('div', {
    className: 'my-1 w-full overflow-hidden rounded-[4px] border border-(--ui-stroke-secondary)',
    children: [
      jsx('div', {
        className: 'flex items-center gap-1.5 border-b border-(--ui-stroke-quaternary) px-2 py-1 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [
          jsx(Codicon, { name: 'type-hierarchy' }),
          jsx('span', { children: title })
        ]
      }),
      jsx('div', { className: 'bg-(--ui-bg-card)', children })
    ]
  })
}

function InlineStateGraph() {
  const trails = useValue($trails)
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const sid = focused || active || ''
  const trail = sid ? trails[sid] : null

  return jsx(DirectiveFrame, {
    title: `agent state graph · ${sid ? clip(sid, 18) : 'no session'}`,
    children: jsx('div', { className: 'h-64', children: jsx(GraphView, { trail }) })
  })
}

function InlineToolTrail() {
  const trails = useValue($trails)
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const sid = focused || active || ''
  const trail = sid ? trails[sid] : null
  const cards = trail ? trail.cards.filter(card => !card.seeded).slice(-12) : []

  return jsx(DirectiveFrame, {
    title: `tool audit trail · ${cards.length} call(s)`,
    children: cards.length
      ? jsx('div', {
          className: 'max-h-72 overflow-auto py-1',
          children: cards.map(card =>
            jsx('div', { className: 'px-2', children: jsx(CardStatic, { card }) }, card.key)
          )
        })
      : jsx('div', { className: 'px-2 py-2 text-(--ui-text-quaternary)', children: 'no tool calls yet' })
  })
}

/** Directive context has no plugin ctx, so the inline variant is read-only. */
function CardStatic({ card }) {
  const title = card.task ? `${card.task.verb} ${card.task.target}`.trim() : card.name

  return jsxs('div', {
    className: 'flex items-start gap-2 border-b border-(--ui-stroke-quaternary) py-1 text-xs',
    children: [
      jsx('span', { className: 'mt-1', children: jsx(StatusDot, { tone: STATUS_TONE[card.status] || 'muted' }) }),
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: title }),
          jsx('span', {
            className: 'ml-2 rounded-[3px] bg-(--ui-bg-quaternary) px-1 py-px font-mono text-[0.6rem] text-(--ui-text-quaternary)',
            children: card.name
          }),
          card.command
            ? jsx('span', {
                className: 'ml-2 truncate font-mono text-(--ui-text-tertiary)',
                children: clip(card.command, 80)
              })
            : null
        ]
      }),
      jsx('span', { className: 'shrink-0 text-(--ui-text-quaternary)', children: durationLabel(card) })
    ]
  })
}

// ── plugin ─────────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: 'Agent State Graph',
  description: 'Live agent state machine + interactive tool-card audit trail.',
  register(ctx) {
    // One line at load: the desktop log is the only place a disk plugin can
    // report that it came up (its console lands in ~/.hermes/logs/desktop.log).
    console.info(`[${PLUGIN_ID}] loaded — pane, statusbar chip, directives ::state-graph / ::tool-trail`)

    const disposeEvent = host.onEvent('*', handleEvent)

    ctx.onDispose(disposeEvent)

    // Turn boundaries + seeding follow the focused chat.
    let lastBusy = false
    let lastSid = ''

    const disposeBusy = host.state.busy.listen(value => {
      const busy = Boolean(value)

      if (busy && !lastBusy) {
        beginTurn(currentSid())
      }

      lastBusy = busy
    })

    const disposeFocus = host.state.focusedSessionId.listen(value => {
      const sid = typeof value === 'string' ? value : ''

      if (sid && sid !== lastSid) {
        lastSid = sid
        void seedFromHistory(sid)
      }
    })

    ctx.onDispose(disposeBusy)
    ctx.onDispose(disposeFocus)
    void seedFromHistory(currentSid())

    ctx.registerMany([
      {
        id: 'pane',
        area: 'panes',
        title: 'State Graph',
        // The audit-trail deck: below the conversation in the workspace zone,
        // so cards read in flow between the prompt above and the answer.
        data: {
          placement: 'main',
          height: '260px',
          minHeight: '140px',
          dock: { pane: 'workspace', pos: 'bottom' }
        },
        render: () => jsx(StateGraphPane, { ctx })
      },
      {
        id: 'chip',
        area: 'statusBar.right',
        order: 96,
        render: () => jsx(StateChip, { ctx })
      },
      {
        id: 'directive-state-graph',
        area: 'transcript.directives',
        data: { name: 'state-graph', render: () => jsx(InlineStateGraph, {}) }
      },
      {
        id: 'directive-tool-trail',
        area: 'transcript.directives',
        data: { name: 'tool-trail', render: () => jsx(InlineToolTrail, {}) }
      },
      {
        id: 'cmd-reset',
        area: 'palette',
        data: {
          id: `${PLUGIN_ID}.reset`,
          label: 'State Graph: Reset captured state',
          keywords: ['state', 'graph', 'reset', 'trail'],
          run: () => {
            $trails.set({})
            host.notify({ kind: 'info', message: 'State graph reset' })
          }
        }
      },
      {
        id: 'cmd-view',
        area: 'palette',
        data: {
          id: `${PLUGIN_ID}.view`,
          label: 'State Graph: Toggle graph / trail view',
          keywords: ['state', 'graph', 'trail', 'view'],
          run: () => $view.set($view.get() === 'graph' ? 'trail' : 'graph')
        }
      }
    ])
  }
}

// Test/inspection surface. The desktop loader only reads the DEFAULT export, so
// these extra named exports are inert at runtime — they let an offline harness
// (and a debugging session) drive the real renderer and read the real store
// instead of standing up a second module instance with its own atoms.
export { GraphView, layoutGraph, ToolCard, nodeDetail, $trails, $expanded, $expandedLanes, $detail }
