# Changelog

## Unreleased

- `maw herdr ls --path` prints each workspace's checkout beneath its row, as a
  full absolute path that pastes straight into `cd` (#56). The data was already
  in `--json` as `checkout`; only the human-facing view lacked it.
- `--help` / `-h` after any verb prints the usage instead of `unknown argument`,
  and runs nothing. A usage error with no fix line of its own now ends with
  `maw herdr <verb> --help`. A verb that does not exist is still
  `unknown command` (exit 2) with `--help` after it, so probing for a verb
  cannot get a false yes. `wake <oracle> --kind -h` is now a help request: it
  used to take `-h` as the engine, create a workspace, and fail on
  `agent start`, leaving the workspace behind.
- `maw herdr ls` groups workspaces by herdr's `repo_key` (the shared git dir)
  instead of the repo name. Two same-named checkouts from different orgs are
  now two groups, and a group prints every mother workspace, where before the
  second one was dropped from the tree without notice.
- Add `maw herdr serve --mcp` (#61): MCP over Streamable HTTP at `/mcp` on the
  dashboard listener, hand-written JSON-RPC with no new dependency. Read tools
  (`herdr_sessions`, `herdr_agents`, `herdr_capture`, `herdr_worktrees`) call
  the same routes as their HTTP twins and follow the mode; write tools
  (`herdr_send`, `herdr_wake`) require the operator token in every mode,
  including `--insecure-no-token`. Refused under `--engine`. Every MCP error,
  including a wrong Content-Type (415) and an over-limit frame (413), stays
  inside the JSON-RPC envelope and ends with a runnable fix command. Paths are
  shell-quoted, and caller input is never echoed into one.

- Remove the Go server: the dashboard is TypeScript on Bun only. `--runtime`,
  `--build` and `MAW_HERDR_SERVE_BIN` now fail with the command to use instead,
  packages ship no `bin/maw-herdr-serve` and no `bundledArtifacts`, and CI no
  longer installs Go. The 63-file Go implementation remains in git history and
  can be restored; nothing about the HTTP/WebSocket contract changed.
- Every token-file error now ends with a copy-pasteable command, with the real
  path substituted for the `chmod` hint.

- Align serving with maw-rs `engine.serve` and checksum-pinned `bundledArtifacts`:
  source-independent native packages for Linux/macOS amd64/arm64, no implicit Go
  compilation, explicit developer `--build`, and host-managed namespaced mode.
  Direct standalone authentication remains separate from the gateway trust model.
- Verify actual `maw herdr serve` dispatch in an isolated installation. The
  command is `herdr`, not `herder`; Git-only installs may omit companion files.

- Add `maw herdr serve`: existing Bun plugin launcher with a Go-backed core
  dashboard API and live WebSocket captures. Requires a private operator token,
  loopback binding, and Herdr protocol 22. Agent prompts report acceptance, not
  delivery/completion. Full lifecycle, PTY, federation and queue parity remain
  out of scope.
- Add isolated API, WebSocket, backend and launcher regression checks; no live
  sessions are written during tests. Packaged installs include the pinned native
  companion; source development requires explicit `--build` from a complete checkout.

## 0.4.0 — 2026-09-17

- `maw herdr federation` (alias `fed`): draws the mesh — who federates with whom,
  each link's health, panes per node, and what peers report about themselves. The
  one verb that does not talk to the herdr socket, because herdr has no remote RPC
  (`herdr --remote` is launch-only); it reads a herdr-federation node over HTTP,
  which already syncs every peer's roster. `HERDR_FED_URL` retargets it, `--json`
  for machines.
- Reciprocity is drawn, not assumed: `⇄` mutual, `→` we hold them, `←` they hold
  us, `··` heard but never joined. Enforcement in that service is local-only, so
  a single undirected line would hide the asymmetry that matters.
- `⇠⇢` marks a **stale** edge. What a peer reports arrives only on a successful
  pull, and while the link is down the cache keeps answering — measured: after m5
  kicked white, white still drew `⇄ m5` and "m5 federates with white" while every
  pull returned 401.
- Fixed "17 audit entrys".

## 0.3.1 — 2026-09-17

- Fix: **agent names were never matched.** The name lives on the agent record,
  not on the pane — `snapshot.panes[]` carries neither `name` nor `agent_name`,
  while `snapshot.agents[]` carries `name`, joined by `pane_id`. Reading it off a
  pane returned `undefined` for every agent, so the name tier in target
  resolution was dead code: `herdr agent get zzz-probe` resolved while
  `maw herdr peek zzz-probe` answered "no agent". Joined by `pane_id`, 8 of 26
  agents on the reference machine turned out to be named.
- This also corrects 0.2.0's claim that "0 of 28 panes carried an `agent_name`".
  That was true, and misleading: the field does not exist on a pane at all. The
  conclusion drawn from it — that workspace labels are the handle that always
  exists — still holds, because an agent has no name until someone runs
  `herdr agent rename`.

## 0.3.0 — 2026-09-17

Root-cause fix: **the plugin mapped tmux's "session" onto herdr's "session" by
name, not by role.** In tmux a session is the thing you attach to and work in; in
herdr a session is a *server process*, and the noun that plays that role is a
*workspace*. Measured: `herdr session list` returned 8 sessions, 7 stopped and
reporting 0 panes, while the one running session held 22 workspaces across 7
repos with 13 linked worktrees.

- `maw herdr ls` now lists **workspaces**, grouped machine → repo → worktree, in
  the shape herdr's own sidebar draws — with branch and `↑↓` from local git reads
  only (one `rev-list --left-right --count`, never a fetch). A worktree's branch
  is printed only when it differs from the label, and a workspace with no
  `worktree` block still gets one from its pane's cwd. Remote machines are
  separate SSH-reached servers, so the listing is local and names them rather
  than implying the fleet is one machine.
- `maw herdr ls --sessions` keeps the old server listing and now names the
  stopped ones as what they are.
- `maw herdr wake` creates a workspace in the **running** session instead of
  spawning a server per oracle — the same confusion in the other direction, and
  the source of seven stopped socket directories under
  `~/.config/herdr/sessions/`, which were precisely the seven noise rows in the
  old `ls`. `--own-session` restores the old behaviour; without it wake refuses
  rather than silently starting a server when no session is running.

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
