# Changelog

## 0.2.0 — 2026-09-17

- `maw herdr hey <target> <message>`: `maw hey` for herdr — resolves a target and
  runs `herdr agent prompt <pane> <message>`. Everything after the target is the
  message, so quotes are optional. `--dry-run` prints the herdr call and sends
  nothing.
- `maw herdr peek <target>` (alias `read`), with `--lines N` and `--json`: read
  what an agent's pane is showing.
- `maw herdr ls --agents`, with `--json`: every agent pane across every running
  session, grouped by session, with status and the focused pane marked.
- Targets resolve by pane id, agent name, workspace label, tab label, then a
  unique prefix or substring of the label. **Workspace labels are the handle that
  matters**: 0 of 28 panes on the reference machine carried an `agent_name`, so a
  name-based design would have addressed nothing. A plural match is narrowed to
  the focused pane, then the workspace's active tab; anything left is listed
  rather than guessed. `--session <name>` scopes first — a flag, never a
  `session:target` prefix, because pane ids are colon-shaped too.
- `peek` always reads `--source visible`, and that is deliberately not
  configurable: herdr's own default is `recent`, which asks for scrollback and,
  on an idle agent, is serviced by driving the pane's own mouse-scroll — the
  operator watches their real terminal scroll and snap back once per read (and a
  400-line `recent` read measured 13.8s against ~0.1s for `visible`).
- The roster comes from `herdr api snapshot`, not `agent list`: the latter
  returns one row per agent and collapses a split tab into a single entry (25
  against 28 panes on the same machine), and carries no `tab_id`/`workspace_id`
  to resolve a label with.

## 0.1.0 — 2026-09-13

- `maw herdr ls` / `maw herdr ls --json`: list herdr sessions with pane and
  agent counts, `--json` mirroring the `maw ls --json` envelope.
- `maw herdr a <session>` (alias `attach`), with `--print`: attach to a herdr
  session; targets resolve like `maw a` (exact, unique prefix, unique
  substring), ambiguity lists candidates, stopped and unknown sessions are
  refused. Usage mistakes exit 2, lookup failures exit 1, like `maw a`.
- `maw herdr wake <oracle>`: `maw wake` for herdr — one headless herdr
  session per oracle (named after the repo), a workspace in the checkout, and
  `herdr agent start` with `--engine` mapped onto herdr's agent kinds;
  `--prompt`, `--attach`, `--dry-run`; idempotent when the agent already runs.
  Targets resolve from `~/.maw/oracles.json` by name, `org/repo`, or path.
- Unknown session: the error also lists matching tmux sessions from
  `maw ls --json` as "Found nearby (tmux, not herdr)" with the `maw a` command
  to run, since the two multiplexers cannot see each other.
- Attach only queries `herdr session list`; pane/agent counts are fetched by
  `ls` alone, so one wedged session cannot stall an attach.
- Without a terminal on stdin (maw before #992), attach refuses with the exact
  `herdr` command to run instead of launching a TUI into a null stdin.
- `cli.interactive: true` in the manifest so maw can inherit stdin for the TUI
  (maw-rs #992).
- `smoke.sh`, CI-safe: skips herdr-dependent checks when the binary is absent.
