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
maw herdr ls --path             # ...each workspace's checkout path beneath it
maw herdr ls resumable          # every worktree in one state: running|open|resumable|cold
maw herdr ls --sessions         # herdr server instances
maw herdr ls --agents           # every agent pane, every session
maw herdr ls --json             # any of the above, as JSON
maw herdr a <session>           # attach (alias: attach)
maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach]
maw herdr hey <target> <msg>    # submit a prompt to an agent
maw herdr peek <target>         # read what an agent's pane shows [--lines N]
maw herdr resolve [<target>]    # what a target resolves to, and how; never acts
maw herdr federation            # draw the cross-machine mesh (alias: fed)
```

`--help` or `-h` after any verb prints the usage instead of failing as an
unknown argument. For `hey` it counts only when no message follows the target,
so `maw herdr hey neo why does -h fail` still sends.

### Session vs. workspace

herdr's "session" is a server process (one socket); the tmux-session role —
the thing you actually attach to — is a **workspace**. `ls` lists workspaces,
not sessions. Measured: 8 sessions on the reference machine, 7 stopped/empty,
one running session holding 22 workspaces across 7 repos. `ls --sessions`
keeps the raw server listing if you need it.

`●` working, `○` idle. Branch/`↑↓` come from a local git read only — never a
fetch, never blocks on network.

### Worktree states

A worktree is in one of four states, whether or not a herdr space is open on it:

| state | meaning | who knows |
|---|---|---|
| running | an agent is live in a pane | herdr |
| open | a space is open, no agent | herdr |
| resumable | no space, but a transcript exists to resume from | a resume provider |
| cold | nothing | — |

Plain `ls` adds one line counting every checkout on disk by state
(`290 checkouts · 28 running · …` — "checkouts" because the tree's own footer
already says "worktrees" for linked worktrees with a space open); `ls <state>`
(or `--state <state>`) lists the worktrees in that state, repo → worktree, and
combines with `--path` and `--json`. `--json` keeps the `workspaces` array
(each row now carries `state` and `agents`) and adds `worktrees`, `states`
(the counts) and `providers`. A resumable row carries `resume.command`, the
agent's own resume line, runnable as printed; a transcript whose session id is
not a plain `[A-Za-z0-9._-]` token is never offered.

A listing can be short, and then it says so on stderr, each warning ending in
the command that shows the cause, and `--json` names what is missing:

- `incomplete`: herdr sessions whose `api snapshot` failed or did not parse.
  Their spaces are absent, so a worktree with a live agent in one of them shows
  as resumable or cold. Check with `herdr --session <name> api snapshot`.
- `unreadable`: repos `git worktree list` failed on (dubious ownership, a
  corrupt `.git/worktrees` entry). Their closed worktrees are absent from the
  counts. Check with `git -C <repo> worktree list`.

Both are empty arrays on a complete listing. The scan runs at most 8 gits at once.

Worktrees come from git: every repo under the ghq root (`$GHQ_ROOT`, else
`ghq root --all`, else `ghq_root` in `~/.maw/oracles.json`) with at least one
linked worktree, plus the repo of every open space. A repo that never used a
worktree and has no space open is a clone, not a workspace, and is not listed.

"Resumable" is the only state herdr cannot answer, so it comes from providers,
not from a path baked into the plugin. Two ship built in:

| provider | looks in | default root | override |
|---|---|---|---|
| `claude` | `<root>/<cwd with every non-alphanumeric as ->/*.jsonl` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` | `MAW_HERDR_CLAUDE_ROOTS` |
| `codex` | `<root>/YYYY/MM/DD/rollout-*.jsonl`, matched on the `cwd` in the first line | `$CODEX_HOME/sessions`, else `~/.codex/sessions` | `MAW_HERDR_CODEX_ROOTS` |

Root lists are `:`-separated. A transcript under 1 KiB, or a Codex subagent
thread, is not counted as resumable. `MAW_HERDR_RESUME_PROVIDERS=claude` runs
only one; `MAW_HERDR_RESUME_PROVIDERS=none` runs none, and `ls` then reports
running, open and cold and never calls anything resumable. The interface a new
provider implements is documented at the top of `src/cli/mod.resumeProviders.mjs`.

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
| Prompt delivery | `POST /api/send` → `[node:oracle]` sender tag, literal attachments, draft/blocked/changed-pane refusal, `delivered`/`queued`/`accepted` receipt |
| Fleet wake | `POST /api/wake` with a `task` → new/reused worktree |
| Not included | full lifecycle control, inbound pairing, config mutation |

`POST /api/send` receipts name what was observed, never that the agent read
the prompt: `accepted` is herdr taking it, `delivered` is the input box seen
empty afterwards, `queued` is the agent showing it queued. A draft already in
the box, a blocked agent, or a pane that changed under the request is refused
with `409` and a `hint` holding the herdr command that shows why. If the
input box cannot be read first, nothing is typed (`503`).

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

## Serving a dashboard

```bash
# read-only demo: no token, stops itself, logs every request
maw herdr serve --insecure-no-token --listen 127.0.0.1:3488 --demo-minutes 60

# a dashboard on another origin must be named, or it gets 403 origin_not_allowed
maw herdr serve --insecure-no-token --listen 127.0.0.1:3488 --demo-minutes 60 \
  --allow-origin https://village.buildwithoracle.com \
  --allow-origin https://bridge.buildwithoracle.com

# writes — send, wake, cleanup — need the token file
maw herdr serve --token-file ~/.maw-herdr-token --listen 127.0.0.1:3457
```

Loopback pages and `god.buildwithoracle.com` are allowed built-in. Everything
else is opt-in per origin: an allowed origin can read every pane this server can
see, so there are no wildcards.

`--access-log` prints an nginx-style line per request to stderr as it happens,
and is on by default under `--insecure-no-token`. Tokens and tickets never reach
it. A page that sits on "offline" with nothing in the log was blocked by the
browser before the request left — usually Private Network Access on an HTTPS
page reaching loopback.
