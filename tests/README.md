# Offline tests

No Hermes app, no gateway, no network. These render `desktop/state-graph/plugin.js`
with `react-dom/server`, drive real gateway-shaped events at the real store, and
assert on the markup it produces and on `layoutGraph`'s geometry.

```bash
./setup.sh                  # npm deps + the SDK stub symlink + copy the plugin under test
node run.mjs                # the full suite (46 checks)
node structure.mjs          # [a] -> …… -> [h] -> …… -> [z], with branches off [h]
node fork.mjs               # two branches leave one node from the same point
node click.mjs              # the `… N` chip is a button, not a label
node click-dom.mjs          # ...and a real dispatched click opens the lane
node long.mjs               # a 30-step lane stays finite and elided
```

`./setup.sh <path/to/plugin.js>` tests a build other than the installed one.

## What each probe is for

| File | Question it answers |
| --- | --- |
| `run.mjs` | Does the pane render at all — bands, lanes, cards, badges, filters, directives, seeding from history? 46 checks, ~1s. |
| `structure.mjs` | When a lane is long *and* has branches, does the fork node stay visible between two `… N` chips, with the branches hanging off it? |
| `fork.mjs` | Do two branches off one node leave from the same point, one cell to the right? |
| `click.mjs` | Is the chip clickable state wired (open spells the hidden steps out, the toggle moves to the lane end and closes it)? |
| `freeze.mjs` | Does the dot hop rest on a deterministic frame (a multiple of the 8px slot) once the stream goes idle? |
| `fit.mjs` | At the current card size, do the wrapped titles still fit the 148x38 card, and do the two baselines stay inside the 38px height? |
| `click-dom.mjs` | Does a real `MouseEvent` on the chip actually flip the store? SSR cannot prove a handler — this mounts the component in jsdom. |
| `long.mjs` | A single long lane: does anything go `NaN`, and does it stay elided? |

## Notes

- **`click-dom.mjs` must run without `NODE_ENV=production`** — React 19 omits
  `act` from production builds, and the mount needs it.
- `sdk-stub/@hermes/plugin-sdk` is a local stand-in for the real module. It gives
  you the real `nanostores` atoms and the real `@nanostores/react` `useStore`, and
  light stubs for the app's UI kit — the kit itself cannot resolve outside the
  app's Vite build, but the stub is enough to prove the plugin's own tree renders,
  its hooks are legal, and its store plumbing works.
- Geometry assertions are in **plugin units**: `CELL_W` is the column pitch, so a
  branch one cell right of its fork node is `fork.x + CELL_W`, and an elbow leaves
  the card's right edge at `fork.x + STEP_W`. The probes hardcode the current
  constants (`CELL_W` 226, `STEP_W` 148) — if you retune the geometry block at the
  top of `plugin.js`, update those numbers in `fork.mjs`/`structure.mjs`/`fit.mjs`.
- A trap worth knowing if you add probes: `markerEnd="url(...)"` contains the
  substring `d="`, so `/d="([^"]+)"/` matches it. Anchor on the path —
  `/d="(M [^"]*)"/`.
