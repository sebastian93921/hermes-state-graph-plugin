<img width="1227" height="685" alt="image" src="https://github.com/user-attachments/assets/c3da952b-b401-4a56-88fc-5a3eabcf9944" />

# Hermes Desktop State Graph

See what your agent is actually doing — inside the Hermes desktop app.

The agent declares the work in one sentence, and this plugin paints it: a **graph**
of task bands with a lane per parallel worker and forks where `delegate_task`
fanned out, plus an **audit trail** of the tool cards between your prompt and the
final answer.

<img width="1631" height="331" alt="image" src="https://github.com/user-attachments/assets/5d1a8bac-1d19-4a7c-a9dd-6920a8e4c009" />

Read: the lane keeps its head and tail and collapses the stretches it hides into
`… N` chips you can **click to open**; a branch hangs off the node that spawned
it, not off the band header. Nothing is inferred from tool arguments — the
sentence is written by the agent, through a real tool call.


---

## What you get

| Surface | What it is |
| --- | --- |
| **Pane** `State Graph` | Docked under the conversation (workspace zone, bottom, 260px). Two views: the graph, and the tool-card trail. |
| **Status bar chip** | Live phase for the focused chat; click to focus the pane. |
| **Palette** | `State Graph: Toggle graph / trail view`, `State Graph: Reset captured state`. |
| **Transcript directives** | `::state-graph` and `::tool-trail` render the widget inline in a message. |
| **Agent tool** | `state_graph_note(summary, status)` — the agent's own one-sentence declaration. |
| **Gate** | Work tools are vetoed until that note lands, so the label is written before execution, not reconstructed after. |

Both halves are optional in the sense that they work independently — the graph
renders from gateway events alone, and the note tool + gate work with no pane
open — but together is the point.

---

## Requirements

- **Hermes desktop app** (`hermes desktop`). This uses the *desktop* plugin SDK
  (`@hermes/plugin-sdk`, `$HERMES_HOME/desktop-plugins/`). It is **not** the web
  dashboard plugin system and not a Python CLI plugin.
- The desktop half is plain ESM: **no build step, no npm install**.
- The agent half needs nothing beyond Hermes itself.
- Node is only needed to run the offline tests.

---

## Install

```bash
git clone https://github.com/sebastian93921/hermes-state-graph-plugin.git
cd hermes-state-graph-plugin
./install.sh
```

`install.sh` copies the two halves into `$HERMES_HOME` (default `~/.hermes`),
enables the agent half, and prints what to do next. It is idempotent — run it
again after `git pull` to update.

### Manual install

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

# 1. desktop half — the pane, the chip, the directives, the palette commands
mkdir -p "$HERMES_HOME/desktop-plugins/state-graph"
cp desktop/state-graph/plugin.js "$HERMES_HOME/desktop-plugins/state-graph/"

# 2. agent half — the state_graph_note tool and the gate hooks
mkdir -p "$HERMES_HOME/plugins/state-graph"
cp agent/state-graph/plugin.py agent/state-graph/plugin.yaml agent/state-graph/__init__.py \
   "$HERMES_HOME/plugins/state-graph/"

# 3. optional: guidance so the agent declares tasks without being told every time
mkdir -p "$HERMES_HOME/skills/state-graph-directives"
cp skill/SKILL.md "$HERMES_HOME/skills/state-graph-directives/"
```

Then turn the agent half on and confirm it registered:

```bash
hermes plugins enable state-graph
hermes plugins list                                  # expect: ✓ enabled  state_graph
hermes plugins doctor "$HERMES_HOME/plugins/state-graph" --ci
#   OK: runtime discovery, manifest parsing, import, and registration passed
#   registrations: 1 tool(s), 2 hook(s)
```

### Finish the install

1. **Restart the gateway** in the app (**⌘K → Restart gateway**). The agent half
   is loaded at gateway startup, so a running gateway keeps its old tool and hook
   set until it restarts.
2. **Open a new chat.** A session's tool catalog is fixed when it is created: a
   chat that existed before the plugin was enabled will never see
   `state_graph_note` — and with the gate on, that chat pays two retries per turn
   (see *Gate* below).
3. The desktop half needs no restart: the app picks up
   `$HERMES_HOME/desktop-plugins/state-graph/plugin.js` within a few seconds and
   hot-reloads on every save.

---

## Using it

**The graph.** One **band** per declared task — the band's title is the agent's
own sentence. Inside a band, one **row per lane**: the agent's own work runs in
the `main` lane, each subagent runs in its own lane, side by side. Where a branch
started, an **elbow** leaves the node that spawned it.

**The `… N` chips.** A long lane doesn't scroll forever: it keeps its first step,
its last few, the step the agent is on, and any node a branch forks off — and
collapses each hidden stretch into a `… N` chip. **Click a chip** and that lane's
hidden steps are spelled out in place; the chip becomes `▴ N` at the end of the
lane, and clicking it puts the elision back. Hover a chip for what it hides.

**The trail.** The same events as cards: task title, the tool, its arguments
(terminal calls are broken into `command` and `timeout`, since the command is
what you read), the result, and how long it took. Filter to the current turn or
to failures; expand a card for the full detail.

**The gate.** Before the agent runs a work tool in a new request, it must first
call `state_graph_note`. If it doesn't, the tool call is vetoed and the veto text
tells it exactly what to call:

```
BLOCKED before running terminal: declare the work first.
Call state_graph_note(summary="<one short sentence naming what you are about to do>"),
then retry this call.
```

The gate is bounded so it can never wedge a session: `clarify`, `memory`,
`session_search`, `skill_view`, `skills_list` and `todo_list` always pass; after
2 vetoes in one request it fails open for the rest of that request; and the whole
thing is off with `STATE_GRAPH_GATE=0`.

| Variable | Default | Effect |
| --- | --- | --- |
| `STATE_GRAPH_GATE` | on | `0` / `false` / `off` / `no` disables the veto entirely; the tool and the graph keep working. |
| `STATE_GRAPH_GATE_DENIALS` | `2` | Vetoes allowed per request before the gate opens. `0` never vetoes. |

---

## How it works

The desktop half subscribes to the gateway event stream (`tool.*`, `message.*`,
`thinking`, `status.update`, `clarify/approval/secret.request`,
`subagent.spawn_requested|tool|thinking|progress|complete`, `todo.updated`,
`error`) and seeds itself once from `session.history`, so a pane opened mid-chat
still shows what already happened. State is written on transitions, not on every
streamed token.

Layout rules worth knowing:

- **Columns are global to a band.** A branch starts one cell to the *right* of the
  node it forked off, so two branches off the same node line up under each other
  instead of every branch restarting at the band header.
- **Elision is structural.** Each contiguous hidden stretch gets its own chip, and
  the four kinds of pinned node above are never hidden — which is what keeps
  `[a] -> …… -> [h] -> …… -> [z]` readable when `[h]` is the fork.
- **A step's lane comes from its own event.** The event's `subagent_id` decides the
  lane, never a sticky cursor, so the agent's own calls made while workers run
  stay in `main`.
- **Caps, so a long session stays cheap:** the newest 40 nodes and 200 cards per
  session are kept. A chip can only open steps still in the trail.

Nothing is derived from tool arguments to invent a task name: without a note, a
band falls back to the in-progress `todo_list` item, and failing that the steps
live in a headerless band with their concrete activity as the label.

---

## Tests

The plugin ships with the offline harness used to build it — no app needed, no
network. It renders the real component with `react-dom/server`, drives real
events at the real store, and asserts on the markup and the geometry.

```bash
cd tests
./setup.sh          # npm deps + symlinks the SDK stub into node_modules
node run.mjs        # the full suite (46 checks)
node structure.mjs  # [a] -> …… -> [h] -> …… -> [z] + branches off [h]
node fork.mjs       # two branches leave one node from the same point
node click.mjs              # the `… N` chip is a button, not a label
node fit.mjs                # two-line labels still fit the 148x38 card
node click-dom.mjs  # ...and a real dispatched click opens the lane (jsdom)
node long.mjs       # a 30-step lane stays finite and elided
```

`tests/sdk-stub/` is a local stand-in for `@hermes/plugin-sdk` that mirrors the
real contract (real `nanostores` atoms, real `@nanostores/react` `useStore`, light
stubs for the UI kit) — the app's own kit cannot resolve outside its Vite build,
but the stub is enough to prove the plugin's tree renders, its hooks are legal,
and its store plumbing works.

> `click-dom.mjs` mounts in jsdom with React 19 and must run **without**
> `NODE_ENV=production` — React omits `act` from production builds.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Pane, chip, directives all missing | The app didn't load the file. Check `~/.hermes/logs/desktop.log` for `runtime load failed (state-graph)` — that line carries the syntax error. |
| Pane empty, "No agent work yet" | No events captured yet for the focused chat. Send a prompt, or the plugin was loaded after the chat started (it seeds from history on load, so reload the pane). |
| `state_graph_note` not in the catalog | The chat predates the plugin, or the gateway hasn't restarted since enabling it. New chat + restart (see *Finish the install*). |
| Tool calls come back `BLOCKED … declare the work first` | The gate doing its job — the agent retries after the note. Persistent? `STATE_GRAPH_GATE=0`. |
| Everything works, but the bands have no titles | The agent isn't calling `state_graph_note`. Install the skill (`skill/SKILL.md`) so it knows to, or ask it in-prompt. |
| Graph looks stale after an edit | The plugin hot-reloads in ~5s; `touch plugin.js` to force it. |

---

## License

MIT — see [LICENSE](LICENSE).
