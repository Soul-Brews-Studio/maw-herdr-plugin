# maw-herdr-plugin

`maw herdr ls/a/wake/hey/peek` — maw's own verbs, pointed at
[herdr](https://herdr.dev). Dev-tier JS plugin (`runtime: "bun-dev"`). The
dashboard server is TypeScript on Bun — no compiler, no native helper.

## Install

```bash
maw plugin install Soul-Brews-Studio/maw-herdr-plugin --root ~/.maw/plugins
maw plugin ls          # herdr, health: ok
maw herdr ls
```

`owner/repo` expands to GitHub; `owner/repo@ref` pins branch/tag. Command is
`herdr`, not `herder`.

From a clone, use the justfile (split into `local`/`remote`/`fleet` modules):

```bash
just local install              # this machine, from source
just serve install               # build + install the plugin package
just remote up god@white.local   # install + smoke on a remote
just fleet status                # versions across every machine
```

⚠️ **Never `maw plugin install .` from a checkout that went through `/incubate`.**
`/incubate`'s `ψ` symlink cycles back into itself — the installer walks it
forever. Measured: 3.5 GB written before kill, plugin left with no
`index.mjs`. `just install` stages via `git archive` (tracked files only, no
`ψ`), which is immune.

## Verbs

```bash
maw herdr ls                    # workspaces, grouped machine → repo → worktree
maw herdr ls --sessions         # herdr server instances
maw herdr ls --agents           # every agent pane, every session
maw herdr ls --json             # any of the above, as JSON
maw herdr a <session>           # attach (alias: attach)
maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach]
maw herdr hey <target> <msg>    # submit a prompt to an agent
maw herdr peek <target>         # read what an agent's pane shows [--lines N]
maw herdr resolve [<target>]    # what a target resolves to, and how; never acts
maw herdr restart [<target>]    # quit the agent, relaunch it in the same pane and name
maw herdr resume [<target>]     # start the agent on its worktree's newest transcript
maw herdr kill [<target>]       # ctrl+c the agent until it exits; the pane stays
maw herdr close [<target>]      # close the herdr space; the worktree stays [--force]
maw herdr federation            # draw the cross-machine mesh (alias: fed)
```

### Session vs. workspace

herdr's "session" is a server process (one socket); the tmux-session role —
the thing you actually attach to — is a **workspace**. `ls` lists workspaces,
not sessions. Measured: 8 sessions on the reference machine, 7 stopped/empty,
one running session holding 22 workspaces across 7 repos. `ls --sessions`
keeps the raw server listing if you need it.

`●` working, `○` idle. Branch/`↑↓` come from a local git read only — never a
fetch, never blocks on network.

### Wake

`maw herdr wake <oracle>` creates a workspace **inside the running session**
and starts the agent there, instead of spinning up a dedicated session per
oracle (the old behavior — `--own-session` restores it). Target resolves from
`~/.maw/oracles.json`: a registry name, `org/repo`, or a directory.

```bash
maw herdr wake neo --dry-run
maw herdr wake laris-co/neo-oracle --engine codex
maw herdr wake neo --prompt "recap the last session" --attach
```

### Targets — one grammar for every verb

| form | meaning |
|---|---|
| `self` | the pane you are typing in (from `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`); the default where a target is optional |
| `/abs/path`, `.`, `../x` | the git worktree containing that path (a linked worktree, never its main checkout, when you are inside one) |
| `w5D:p1` | a herdr pane id |
| `digger-oracle` | a name: exact label → a repo's main worktree → unique substring |

An ambiguous target lists every candidate as a runnable command and exits 1;
nothing is picked for you. `--dry` (alias `--dry-run`) prints the resolution
and does nothing. `maw herdr resolve <target>` shows what any target means,
including worktrees with no open space; `resolve --list` shows everything it
can name. The resolver is `src/cli/mod.target.mjs`.

### Lifecycle — restart, resume, kill, close

All four take the target grammar above and honour `--dry`, which prints what the
target resolved to and the exact herdr commands, then does nothing.

- **restart** reads the agent's argv from its *running process* — the pane's
  foreground pid from `herdr pane process-info`, argv from `/proc/<pid>/cmdline`
  (Linux) or `ps -p <pid>` (macOS, split as herdr reports it and only when the two
  agree) — quits it with Ctrl-C until the pid is gone, and relaunches it in the same
  pane under the same herdr name with `herdr agent start … -- <argv>`. Repeated flags
  are dropped (a shell alias re-adds them on every relaunch) and, for claude and
  codex, the session is pinned to the one herdr reports for the pane. Any other kind
  is relaunched with its argv as read. `--channel <entry>` / `--no-channel` add or
  drop a claude development channel; the startup warning is accepted. A target with
  no live agent has no argv to read: restart fails and prints the `resume` command.
- **restart self** from an agent's own `!` prompt, or any restart/kill whose target
  process is an ancestor of the command, hands off to a detached worker and returns
  at once; the worker logs to `~/.maw/herdr/lifecycle.log` (maw's state dir). With two
  agents in one worktree, `self` is exactly your pane; a name lists both panes.
- **resume** finds the newest transcript for the worktree through the resume
  providers (Claude and Codex, `MAW_HERDR_RESUME_PROVIDERS`, `MAW_HERDR_CLAUDE_ROOTS`,
  `MAW_HERDR_CODEX_ROOTS`), opens the worktree's space with
  `herdr worktree open --cwd <repo> --path <worktree>` if it has none, and starts the
  agent on that session. It refuses a target that already runs an agent.
- **kill** stops the agent; the pane and space stay, so `resume` can bring it back.
- **close** closes the space; the worktree and transcript stay. A space with a live
  agent needs `--force` (the refusal lists the `kill` for each agent).

### Hey and peek — targeting

hey and peek take the grammar above. `self` is the agent in your own pane; a
path is the agent(s) whose cwd belongs to the worktree containing that path.
Neither ever falls back to name matching — a miss is an error, so `hey self`
from a bare shell cannot land in a workspace that merely has "self" in its
label. Names keep hey/peek's own agent tiers: pane id → agent name → workspace
label → tab label → unique prefix/substring. Workspace label is the handle that
always exists (agents are unnamed until `herdr agent rename`). Within one space
the focused pane, then the active tab, picks among that space's agents; across
two spaces or sessions nothing is picked. Ambiguous matches are listed, never
guessed:

```bash
$ maw herdr peek neo-oracle
'neo-oracle' matches 4 agent panes and none is focused:
    wD:p4    neo-oracle/neo         claude (working)
    wD:pS    neo-oracle/neo         omp (idle)
  target one by pane id: maw herdr peek wD:p4
```

`peek` always reads `--source visible` (the rendered viewport) — never
scrollback. herdr's own default (`recent`) drives the pane's real mouse-scroll
to fetch it, which is slow (13.8s vs ~0.1s, measured) and visibly hijacks the
operator's terminal. `--lines` (default 40) only trims what's already in view.

### Federation map

`maw herdr federation` reads a
[herdr-federation](https://github.com/Soul-Brews-Studio/herdr-federation) node
over HTTP (`HERDR_FED_URL`, default `127.0.0.1:6750`) — herdr itself has no
remote RPC, so this is the only verb that can see past the local host.

| glyph | meaning |
|---|---|
| `⇄` | mutual |
| `→` / `←` | one-directional hold |
| `··` | heard from, never joined |
| `⇠⇢` | **stale** — last successful pull, may no longer be true |

## `maw herdr serve` — the dashboard

Requires **Bun 1.3.11+, Herdr 0.9.0**. Serves the browser dashboard
(https://god.buildwithoracle.com/) over an authenticated local HTTP+WS API.

```bash
test -e "$HOME/.maw-herdr-token" || \
  (umask 077; openssl rand -hex 32 > "$HOME/.maw-herdr-token")
maw-js herdr serve --token-file "$HOME/.maw-herdr-token" --listen 127.0.0.1:3457
```

Auth is mandatory even on loopback. There is one runtime: TypeScript on Bun.
`--runtime`, `--build` and `MAW_HERDR_SERVE_BIN` were removed and now fail with
the command to use instead.

Coverage vs. the legacy `maw serve`/God UI contract — not full parity:

| Surface | What's there |
|---|---|
| HTTP | sessions, agents, capture, send, identity, config, health |
| WS | sessions/recent/capture/previews/feed, select/subscribe/send |
| Interactive terminal | `/ws/pty` — attach to a real herdr pane, resize, ANSI |
| Federation status | reads `peers.json`, probes each peer's `/api/sessions` |
| Inbox delivery | `POST /api/send {"inbox":true}` → `ψ/inbox`, `queued` |
| Fleet wake | `POST /api/wake` with a `task` → new/reused worktree |
| Not included | full lifecycle control, inbound pairing, config mutation |

Config layering, worktree cleanup, teams inventory, and delivery-feed details
are documented inline in `server/` and `src/serve/bun/` — read the source for
exact field/limit contracts; this README stays a map, not the spec.

## Traps

- **herdr and tmux are sibling multiplexers, not layers.** `maw ls`/`maw herdr
  ls` describe disjoint worlds; no plain `maw` verb reaches a herdr pane.
  Both default to `ctrl+b` — set a different herdr `prefix` before nesting.
- **`herdr machine list` targets are (host, user) pairs, not hosts.** Three
  entries can be the same box under different users with different plugin
  state. Don't assume a bare hostname is unambiguous.
- Interactive attach (`maw herdr a`) needs maw-rs
  [#992](https://github.com/Soul-Brews-Studio/maw-rs/issues/992) for stdin
  handoff; older maw prints the raw `herdr --session …` command instead.

## Requirements

- `herdr` on `PATH` (verified against 0.9.0)
- `bun` (maw runs dev-tier plugins with it)

## Smoke

```bash
just local smoke                  # here, against the installed plugin
just remote smoke god@white.local # there
just serve check                  # Bun build, API/process smokes
```

Skips with a `SKIP:` line (exit 0) when `maw`/`herdr` isn't on `PATH` — safe
in CI.
