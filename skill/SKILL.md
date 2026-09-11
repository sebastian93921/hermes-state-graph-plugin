---
name: state-graph-directives
description: Use when working on the State Graph desktop plugin, or when a reply should show its graph/trail inline. Covers the state_graph_note tool and the ::state-graph / ::tool-trail directives.
---

# State Graph (desktop `state-graph` plugin + `state_graph_note` tool)

Two halves, both installed for the user:

| Half | Where | What it does |
|---|---|---|
| Agent (Python) | `$HERMES_HOME/plugins/state-graph/plugin.py` | registers the **`state_graph_note`** tool |
| Desktop (ESM) | `$HERMES_HOME/desktop-plugins/state-graph/plugin.js` | pane, statusbar chip, palette rows, two transcript directives |

## `state_graph_note` — write the work summary YOURSELF

The user's hard requirement: **summaries are agent-authored, never inferred.**
The plugin deliberately has no heuristic table — "editing plugin.js" is an
activity, not a summary of what the work is. Call the tool when the WORK changes
phase (a new sub-task, a different file/focus, finishing one):

```
state_graph_note(summary="adding agent-authored work summaries to the state graph")
```

- One short sentence, no trailing punctuation, ≤ ~10 words, in the user's terms.
- Call it at the START of a phase, not per tool call. Re-calling it renames the
  nodes that follow and opens a new group in the trail.
- The desktop half reads the call straight off the gateway event stream, so it
  lands instantly and needs no backend bridge. The call itself never appears as
  a card or a graph node — it is a label, not work.
- If the agent also keeps a `todo_list`, the in-progress item is used as a
  fallback label, but a note always wins.

## The two directives

| Directive | Renders |
|---|---|
| `::state-graph` | the forward-only work flow: one node per step, the agent's summary as the headline (concrete activity underneath), arrows between, current highlighted, previous marked |
| `::tool-trail` | the last 12 tool cards of the run (task title, tool tag, fired command/path, duration) |

Both read the LIVE trail of the focused chat. No attributes.

## Rules for emitting

- The directive must be the **entire paragraph**: one line, nothing else on it.
  Prose containing `::` stays prose and will not render.
- Emit **at most one of each per reply**, and only when the turn actually ran
  tools.
- Put `::tool-trail` next to the answer, after the work happened.
- Never invent directive names, and don't add attributes (`::tool-trail{n=5}`
  renders the same as the bare form).

## Example

```
Patched `plugin.js` and reloaded it; the pane picked the new build up in ~5s.

::tool-trail

Both failures were my own typos, not the loader's.
```

## Design language (user preference — keep it)

Read this before editing the plugin's rendering:

- **Summaries are agent-authored only.** No hardcoded/heuristic summary table:
  a card's title is the agent's `state_graph_note` text (or its todo item);
  a step card shows the concrete activity. The user rejected
  "editing plugin.js"-style labels outright — they are activities.
- **The graph is a horizontal BAND chart**: one band per agent task (the
  summary card sits at the band's left, centred, with a `N steps · M in
  parallel` meta line), one ROW per worker inside the band (main + each
  subagent, labelled `⇉ goal`), and each worker's steps flow **left to right**.
  Time is the x axis across the band; parallel lanes share it.
- **Cards are flat tinted fills with bold white titles**, wrapped to two lines
  (`wrapTitle`), kind-tinted via `KIND_FILL` (`task` blue, `tool` purple,
  `state` green, `subagent` orange, `input` yellow, `error` red) — the look of
  the user's reference board, not outlines on a dark background.
- **The current step is marked by a halo** (a soft accent rounded rect behind
  the card, class `sg-halo`), not a text suffix; exactly one halo at a time.
- **Edges carry their verb written ALONG the line** (`angle` from `atan2`, text
  rotated at the midpoint, no backing plate, skipped on connectors shorter than
  ~84px) — "thinks", "calls tool", "answers". Forward-only: no dashed
  loop-backs, no "ran earlier" labels. Cell pitch (`CELL_W`) must stay well
  above `STEP_W` or the labels have nowhere to sit.
- **No separate "work" row** — the trail carries the grouping: cards are
  grouped under the agent summary as a header inside the trail view.
- **The status line carries the mode word** (`Plan`, `Working`, `Needs you`,
  `Delegating`, `Done`, `Failed`) plus the agent's current summary.
- Detail belongs behind the expand chevron (args, result, diff, copy actions),
  not on the face of the card.
- SVG primitives carry stable classes (`sg-node`, `sg-task`, `sg-halo`,
  `sg-edge`, `sg-edge-label`, `sg-task-label`, `sg-activity`, `sg-lane-label`)
  — the offline harness asserts on those, never on font sizes.
- **Never let a coordinate be NaN**: coerce missing node data
  (`Number.isFinite(step.row) ? step.row : 0`). A NaN attribute makes the
  renderer log an error per repaint — ~10 MB of `desktop.log` per 40 s, which
  wedges the whole app and stops the plugin watcher reloading.

## Enforcing the note (the gate)

The user wants the summary written **before** execution, not when the model
remembers. The agent half registers two hooks (declared under `provides_hooks:`
in `plugin.yaml` — the doctor WARNs if they are missing there):

- `pre_llm_call` → returns `{"context": "…"}` once per user prompt telling the
  model to call `state_graph_note` before its first tool call. Injected into the
  USER message, never the system prompt.
- `pre_tool_call` → returns `{"action": "block", "message": "…"}` for any work
  tool until the note lands. That message becomes the tool result, so the model
  reads the exact call to make and retries.

Design rules learned the hard way:

- **Key the gate on the session + the PROMPT, never on `turn_id`.** `turn_id`
  advances between agent steps inside one request, so a turn_id-keyed gate
  demanded a note before nearly every call. `pre_llm_call`'s `user_message` is
  the fingerprint that marks a new request; a change in it resets the gate.
- **Keep an ungated allowlist** (`state_graph_note`, `clarify`, `memory`,
  `session_search`, `skill_view`, `skills_list`, `todo_list`) so a request can
  always start and the gate can never deadlock.
- **Fail open after N denials per prompt** (`STATE_GRAPH_GATE_DENIALS`, default
  2). A session whose tool surface predates the plugin cannot satisfy the gate
  at all, and a stubborn model must not wedge a turn.
- **`STATE_GRAPH_GATE=0` disables enforcement**; the tool and the rendering keep
  working.
- Hooks only exist in a process that loaded the plugin: a running gateway keeps
  its old hook set until it restarts.

## Lane attribution and elision

- **A step's lane comes from the event that produced it, never from a cursor.**
  A sticky `currentLane` set by `subagent.*` events (and cleared only on
  `subagent.complete`) sends the agent's OWN tool calls into the last worker's
  lane: the main lane stops growing exactly when parallelism starts, and one
  worker absorbs steps it never took. Set the lane from `payload.subagent_id`
  for that step and restore `main` immediately after; a completion marker
  belongs to the WORKER's lane, not the agent's.
- **Elide structurally, not everything-in-the-middle.** One chip for the whole
  hidden middle breaks the moment a branch forks off a hidden node. Give each
  contiguous hidden run its own chip, and pin: the first step, the last
  `LANE_MAX_CELLS-1`, the step the agent is on, and every fork-source node — so
  `[a] -> …… -> [h] -> …… -> [z]` stays readable with branches hanging off `[h]`.
- **`MAX_NODES` (40) silently drops the oldest nodes** from a long session, so a
  chip can only open steps still in the trail. Keep fixture sizes under it or the
  lane you are testing disappears rather than failing.
- `step.row` is LANE-local; global arrival order is the step's index in
  `trail.order`.

## Testing an interactive SVG surface

`renderToString` proves markup, never handlers — a click that does nothing still
renders a perfect chip. To prove an onClick, mount the real component:

- jsdom + `react-dom/client` + `createRoot`, then dispatch
  `new dom.window.MouseEvent('click', { bubbles: true })` inside `await act(...)`.
  React 19's `act` is **not** re-exported by the ESM wrapper and is **absent from
  production builds**: `createRequire(import.meta.url)('react').act`, and run that
  probe without `NODE_ENV=production`.
- jsdom implements no scrolling: stub `HTMLElement.prototype.scrollTo` before
  mounting, or the pane's follow-effect throws on mount.
- Assert on drawn nodes and on the store atom, not on a screenshot: 6 cards +
  `… 22` → click → 28 cards + `▴ 22` and the atom set → click → back to 6, atom empty.

## If nothing renders

The plugin must be enabled (Settings → Plugins, or `plugins.enabled` in
`config.yaml` for its backend half — the disk half needs no config). Check
`~/.hermes/logs/desktop.log` for `[plugins] runtime load failed (state-graph)`;
the plugin logs `[state-graph] loaded …` via `console.info`, which does **not**
reach the log file (only error-level renderer console lines are captured).
