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
maw herdr watch [<target>]      # be told when that agent finishes [--every] [--stop] [--list]
maw herdr inbox                 # notes addressed to this pane (watch results, replies); read-only
maw herdr reply <target> <text> # file an answer in that pane's inbox, signed by this pane
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

### Watch and inbox — the return path for hey

`hey` sends; `watch` is how an answer comes back. `maw herdr watch <target>`
(default `self`) files a note in **this pane's** inbox when that agent next
finishes — busy (working, or blocked mid-task) to idle/done. It fires exactly
once per completion: herdr re-sends the same status on title changes and
follows idle with done, and none of that fires. `--every` keeps watching,
one note per completion; `watch <target> --stop` ends it; `watch --list`
shows what this pane watches (`--all`: everyone's).

```bash
maw herdr hey feat-one "run the suite and fix what fails"
maw herdr watch feat-one        # returns at once; the note arrives later
maw herdr inbox                 # ● 14:02:11  finished  feat-one (wB:p2)  working → idle
maw herdr inbox --since <id>    # only what is new; the last line prints the id
```

The agent that was asked answers with `maw herdr reply <asker's pane> "…"`: a
note of kind `reply` in the asker's inbox, signed with the answering pane's
address. It writes one local file and types nothing into anyone's pane.

It learns from herdr's **pushed** `pane.agent_status_changed` events, never a
scan. A CLI verb exits, so each watch is one small detached watcher process
holding one `events.subscribe` connection; it files the note and exits. (Not
`serve`: that is optional and token-gated, and a CLI verb must not depend on
it. Not `herdr agent wait`: it matches the current status, so "working, then
not" would race.) A watch on a pane that closes or whose session stops cleans
itself up and leaves a `vanished` note instead of firing forever. A pane herdr
moves to another workspace gets a new id; the watch follows it (herdr's
`pane.moved` carries the terminal id, which is how a replayed move of some
older pane with the same id is told apart). A watcher killed outright is swept
by the next `watch --list`. Pane ids repeat across sessions, so when one id is
watched in two, `--stop` needs `--session` and says so.

Notes are addressed to a pane (session + pane id), not a person, and live in
`<config>/maw-herdr/inbox/` (`~/Library/Application Support` on macOS,
`$XDG_CONFIG_HOME` or `~/.config` elsewhere) — never in an oracle's `ψ/`.
`inbox` shows this pane's notes only and never marks or deletes anything, so
reading is idempotent. Each note carries the last visible lines of the
finished pane. The implementation is `src/cli/mod.watch.mjs` and
`src/cli/mod.inbox.mjs`.

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
