# maw-herdr-plugin

`maw herdr ls`, `a`, `wake`, `hey` and `peek` — the shape of maw's own verbs, pointed at
[herdr](https://herdr.dev), the terminal multiplexer for AI coding agents. The
plugin shells out to the `herdr` binary and reshapes its output into maw's own
session listing, so the muscle memory is the same whichever multiplexer a
session lives in.

Dev-tier JS plugin (`runtime: "bun-dev"`, `target: "js"`; `maw plugin ls`
files it under the `extra` tier). The plugin executes Herdr and, for `serve`,
its Go backend; source installs also execute Go and write a user-local build cache.
The dashboard reads its token file, stores UI state, and listens on loopback. When you
install from a git URL, maw's JS build step repackages the plugin (the entry
becomes `index.js` and capabilities are re-derived from the code), so
`maw plugin info herdr` is the authority for what actually got installed.

## Install

```bash
maw plugin install Soul-Brews-Studio/maw-herdr-plugin --root ~/.maw/plugins
maw plugin ls          # herdr should be listed, health: ok
maw herdr ls
```

`owner/repo` expands to the GitHub URL; `owner/repo@ref` pins a branch or tag.

From a clone, use the justfile rather than installing the checkout directly. It
is split one module per place the plugin can live — `local` and `remote`:

```bash
just                            # modules and top-level recipes
just --list local               # one module's recipes
just local install              # check, then install here from a clean tree
just local smoke                # smoke suite against what is installed here
just remote up god@white.local  # install there, then smoke it there
just status god@white.local     # versions, here and there

just fleet status               # what every machine has, and what it is missing
just fleet install              # install onto every machine that can take it
just fleet smoke                # smoke every machine that has it
```

## Core dashboard: `maw herdr serve`

Source installs require **Bun, Go 1.23+ and Herdr 0.9.0 (protocol 22)** on PATH. Existing commands and
`maw herdr serve --help` do not require Go. Start the core dashboard backend:

```bash
# Create a private token file once; do not commit it or paste it into URLs.
(umask 077; openssl rand -hex 32 > "$HOME/.maw-herdr-token")
maw herdr serve --token-file "$HOME/.maw-herdr-token"
# Optional: --listen 127.0.0.1:3457 --herdr /absolute/path/to/herdr --data-dir /path/to/state
```

Open <https://god.buildwithoracle.com/>, select backend
`http://127.0.0.1:3457`, then supply the operator token from the file. The token
is mandatory even on loopback; keep it private. Browser local-network policies
may require permission to reach the local backend.

This first slice provides sessions, pane captures/live WebSocket output and
prompt submission through Herdr. It is **not full `maw serve` parity**: no
wake/stop lifecycle controls, PTY terminal emulation, federation, or configuration
mutation. An accepted prompt is not proof the agent completed it. No public
server or remote HTTP/WSS deployment is automated; non-loopback binds are rejected.
Any tunnel or reverse proxy needs its own reviewed security configuration.

The launcher uses `MAW_HERDR_SERVE_BIN=/absolute/path/to/maw-herdr-serve` when
set, otherwise `server/bin/maw-herdr-serve` if supplied with the plugin. There is
**no automatic prebuilt download or release** yet. Without a supplied binary,
it builds bundled `server/` sources into `${XDG_CACHE_HOME:-~/.cache}/maw-herdr/serve`,
keyed by source contents and host platform/architecture. Builds never write to
the installed plugin directory; unchanged sources reuse the cached executable.
The launcher forwards arguments, terminal streams, signals and exit status.

Install from the **GitHub/source archive**, which retains `server/` alongside the
Bun entry. Upstream `maw plugin build` emits a flat JS-only tarball and does not
include these companion sources; that tarball is not a supported installation
route unless a separate server binary is supplied with `MAW_HERDR_SERVE_BIN`.

Core API compatibility:

| Surface | Included |
| --- | --- |
| HTTP | `/api/sessions`, `/api/agents`, `/api/capture`, `/api/captures`, `/api/send`, `/api/identity`, `/api/config`, `/api/health` |
| Browser auth | Bearer token; short-lived, one-use, exact-Origin-bound `/api/auth/ws-ticket` |
| `/ws` | `sessions`, `recent`, `capture`, `previews`; `select`, `subscribe`, `subscribe-previews`, `send` |
| Preferences | `/api/ui-state` object and `/api/asks` array persisted privately under `--data-dir` |
| Not measured | Teams, costs and feed return empty compatibility payloads with `supported: false`; zero costs are **not measured usage** |

Workspace targets use opaque base64url session/workspace IDs and stable pane
numbers, not list positions. Do not save them across daemon resets that reuse
IDs. Capture reads only the visible screen. Sending is agent-only, reports
`state: "accepted"`, and rejects force/inbox/attachments instead of pretending to
implement maw's delivery queue. There are at most 16 live preview targets per
connection and 64 captures per HTTP batch. A capture batch shares one roster and
one 10-second deadline; a backend failure never becomes a fabricated empty roster.

For development (no installation or live Herdr mutation):

```bash
just serve check                 # compile, Go API tests and vet
just local check                 # parse plugin/launcher and manifest
```

### A "machine" is a (host, user) pair, not a host

`herdr machine list` is the default fleet, and its entries are **ssh targets**.
That distinction is load-bearing. Measured 2026-09-17:

```
TARGET                 HOST         OS     TOOLS                              PLUGIN
white.local            white        Linux  maw bun just node python3          none
nm@white.local         white        Linux  maw herdr bun just node python3    herdr@0.3.1
god                    white        Linux  maw herdr bun just node python3    herdr@0.3.1
nazt@100.84.206.23     lima-linux   Linux  just python3                       none
```

Three of those four are the **same host** under different users, and they do not
agree: `white.local` has no `herdr` on `PATH` at all, while `god` and
`nm@white.local` each run their own herdr server with its own panes. Any address
scheme that says "white" without saying which user is ambiguous on this fleet
today.

`just fleet install` skips a target with the reason (`no herdr`, `no maw`,
`unreachable`) rather than failing the run, so one bare box does not stop the
rest. Set `HERDR_FLEET="a b c"` to use a list herdr has never been told about.

### Never `maw plugin install .` from a checkout that has been through `/incubate`

`/incubate` leaves a `ψ` symlink pointing at the oracle vault, and that vault
holds `incubate/<owner>/<repo>/origin` symlinks back to this repo **and to every
other incubated repo** — a cycle. `maw plugin install` dereferences it and walks
forever. Measured: **3.5 GB written** before it was killed, leaving the installed
plugin with no `index.mjs` at all, so `maw herdr` reported itself uninstalled.

`just install` stages through `git archive`, which emits tracked files only — no
`ψ`, no `.git`, no `.claude` — so there is nothing for the installer to walk
into. The same hazard applies to `rsync -L`, `cp -RL`, `tar -h`, and Docker build
contexts over an incubated repo.

## Requirements

- `herdr` on `PATH` (verified against herdr 0.9.0). Without it, `maw herdr help`
  still works and everything else exits non-zero.
- `bun`, because maw runs dev-tier plugins with bun.

Verified on macOS (m5, herdr 0.9.0, maw-rs v26.8.31-alpha) and Linux
(white.local, herdr 0.9.0, maw-rs v26.9.12-alpha) — 13 smoke checks, rc=0 on
both.

## Verbs

```bash
maw herdr ls                    # workspaces, grouped machine → repo → worktree
maw herdr ls --sessions         # herdr server instances (the old listing)
maw herdr ls --agents           # every agent pane across every running session
maw herdr ls --json             # any of the above, as JSON
maw herdr a <session>           # attach (alias: maw herdr attach)
maw herdr a <session> --print   # print the herdr command instead of running it
maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]
maw herdr ls --agents           # every agent pane across every running session
maw herdr hey <target> <msg>    # submit a prompt to an agent   [--dry-run]
maw herdr peek <target>         # read what an agent's pane shows  [--lines N] [--json]
```

### A session is a server. A workspace is where work lives.

This is the distinction the plugin originally got wrong, and it is worth stating
plainly because the two words do not mean the same thing in tmux and in herdr.

In tmux, a session **is** the thing you attach to and work in, so `maw ls` lists
your work. In herdr, a session is a **server process** — one socket under
`~/.config/herdr/sessions/<name>/` — and the noun that plays the tmux-session
role is a **workspace**. One session holds many.

Measured on the reference machine: `herdr session list` returned **8 sessions, 7
of them stopped and reporting 0 panes**, while the single running session held
**22 workspaces across 7 repos, 13 of them linked worktrees**. Listing sessions
was faithful and useless — it showed one row for everything the human actually
works in, and seven rows of dead sockets.

So `ls` lists workspaces, in the shape herdr's own sidebar draws them:

```
  Local
    ● neo-oracle  main ↓14  4 panes
      ├─ ○ neo-herdr-14sep-mon2026  2 panes
      ├─ ○ neo-digger-16sep-wed2026  1 pane
      └─ ○ neo-omp-dream-turso-16sep-wed2026  1 pane
    ○ digger-oracle  alpha  1 pane
    ○ nexus-oracle  main ↑16  1 pane
      ├─ ○ nexus-lancedb-turso-14sep-mon2026  1 pane
      └─ ○ nexus-hyperresearch-14sep-mon2026  1 pane
  22 workspaces · 10 repos · 13 worktrees · agents: maw herdr ls --agents
  remote: white, nm, god — herdr --remote <machine>
```

`●` working, `◌`/`○` idle. Branch and `↑↓` come from local git reads only — one
`rev-list --left-right --count`, never a fetch, so `ls` never touches the network
and never blocks on a remote. A worktree normally sits on a branch of its own
name, so the branch is printed only when it differs from the label. A workspace
with no `worktree` block in the snapshot (a plain shell space) still gets a
branch, read from its pane's cwd — which is how the sidebar shows one for them.

Remote machines are **separate herdr servers reached over SSH**, so this listing
is local and says so; `herdr machine list` names them and
`herdr --remote <machine>` reaches one.

`ls --sessions` keeps the server listing, and now names the stopped ones as what
they are.

`a` resolves its target like the first tiers of `maw a`: an exact name wins,
then a unique prefix, then a unique substring — with a session named
`reviewer`, `maw herdr a rev` attaches to it and prints
`resolved: rev → reviewer`. Several matches list the candidates and ask for the
full name. A stopped session is refused, and an unknown one lists the known
names in the error — and, because herdr and tmux cannot see each other, asks
`maw ls --json` whether the name lives in tmux instead and points you at
`maw a <session>` when it does (`maw herdr a neo` → "Found nearby (tmux, not
herdr): 1. tmux 44-neo (Exact, stale) → maw a 44-neo"). Usage mistakes exit 2,
lookup failures exit 1, as with `maw a`.

## Wake

`maw herdr wake <oracle>` is `maw wake` for herdr: it creates a workspace in the
oracle's checkout **inside the running session** and starts the agent there — `herdr agent start <name> --kind <engine>`, so
`--engine` takes any herdr agent kind (`claude` by default, `codex`, `gemini`,
…). Waking an oracle that is already awake reports the existing agent instead
of starting a second one.

**It used to give each oracle its own session**, and that was the same
session/workspace confusion in the other direction: one socket directory per
oracle that nobody ever attached to again. Seven of them accumulated under
`~/.config/herdr/sessions/`, all stopped — and they were exactly the seven noise
rows in the old `ls`. The fleet does the opposite, running 22 workspaces in one
session. `--own-session` restores the old behaviour for the case where isolation
is genuinely wanted; without it, wake refuses rather than silently starting a
server when no session is running.

The target is resolved from `~/.maw/oracles.json`: a registry `name`, an
`org/repo` (needed when a name is reused across orgs — the registry has such
collisions), or a directory. `--dry-run` prints the herdr commands it would run;
`--prompt` sends a first prompt; `--attach` attaches afterwards (needs a
terminal — see below).

```bash
maw herdr wake neo --dry-run
maw herdr wake laris-co/neo-oracle --engine codex
maw herdr wake neo --prompt "recap the last session" --attach
maw herdr wake neo --own-session          # its own herdr server, the old behaviour
```

## The federation map

`maw herdr federation` (alias `fed`) draws the mesh. It is the one verb that does
not talk to the herdr socket: herdr has no remote RPC, so a plugin on the local
socket can never see past this host. It reads a
[herdr-federation](https://github.com/Soul-Brews-Studio/herdr-federation) node
over HTTP instead — the sibling service, one per machine, which already syncs
every peer's pane roster.

```
$ maw herdr federation
  federation · m5 key 574e75573d85d100  http://127.0.0.1:6750

  ● m5  26 panes · this node
  └─ ⇄ ● white  1 pane · seen 0s ago
         http://100.97.212.120:6750

  elsewhere in the mesh — what peers report, read-only
    white federates with m5

  5 live invites · 0 bans · 18 entries in the audit
  1/1 link mutual · panes elsewhere: 1
```

`HERDR_FED_URL` points it at a node other than `http://127.0.0.1:6750`.
`--json` gives the same thing machine-readably.

### Reciprocity is the point

Enforcement in that service is **local only** — a kick binds the node that issued
it — so "we hold them" and "they report holding us" are two separate facts, and a
map drawing one undirected line between two nodes would hide the state you most
need to see. The arrow says which:

| | |
|---|---|
| `⇄` | mutual — both sides hold each other |
| `→` | we hold them; they do not report holding us |
| `←` | they hold us; we do not hold them — they can reach us, we cannot act on them |
| `··` | heard from, never joined |
| `⇠⇢` | **stale** — the link is failing, so what they report arrived on the last successful pull and may no longer be true |

That last one is not decoration. What a peer reports about itself only arrives on
a successful pull, and while the link is down the cache keeps answering.
Measured: after m5 kicked white, white still drew `⇄ m5` and "m5 federates with
white" while every pull returned 401. A map that asserts stale state as current
is worse than one that shows nothing, so the staleness rides on the edge and on
each mesh row.

## Hey and peek

`maw hey` reaches tmux oracles over federation and cannot see a herdr pane at
all. `maw herdr hey` is its twin on this side: it resolves a target, then runs
`herdr agent prompt <pane> <message>`. `peek` is the read half — what is that
agent showing right now.

```bash
maw herdr ls --agents                      # what can be addressed
maw herdr hey digger "recap the last dig"  # everything after the target is the message
maw herdr peek digger --lines 40           # read the answer
maw herdr hey wF:p1 "…" --dry-run          # resolve and print the herdr call, send nothing
```

### Targets: agent name, pane id, or workspace label

`<target>` resolves in tiers: pane id, agent name, workspace label, tab label,
then a unique prefix or substring of the workspace label.

**The workspace label is the handle that always exists.** An agent has no name
until someone runs `herdr agent rename`, and the fleet mostly does not — so
workspace labels, which are the oracle names already in use (`digger-oracle`,
`pulse-oracle`), are what makes `maw herdr hey digger …` read like `maw hey`.

Name an agent and it becomes directly addressable:

```bash
herdr agent rename "$HERDR_PANE_ID" reviewer
maw herdr hey reviewer "take a look at #12"
```

**The name lives on the agent record, not on the pane.** `snapshot.panes[]`
carries neither `name` nor `agent_name`; `snapshot.agents[]` carries `name`, and
the two are joined by `pane_id`. Reading it off a pane yields `undefined` for
every agent, named or not — which is exactly the bug 0.3.1 fixes, and why 0.2.0
reported that no agent anywhere had a name.

A workspace routinely holds several agent panes — a split tab, or several tabs.
An exact label match is therefore often plural, and the tie is broken by the
focused pane, then by the workspace's active tab. Anything still ambiguous is
**listed, not guessed**:

```
$ maw herdr peek neo-oracle
maw herdr: 'neo-oracle' matches 4 agent panes and none is focused:
    wD:p4    neo-oracle/neo         claude (working)
    wD:pS    neo-oracle/neo         omp (idle)
    wD:pV    neo-oracle/neo         omp (idle)
    wD:pQ    neo-oracle/issue-215   claude (idle)
  target one by pane id: maw herdr peek wD:p4
```

Use `--session <name>` to scope first when two sessions share a label. Scoping
is a flag and never a `session:target` prefix, because pane ids are colon-shaped
too (`wD:p4`).

### peek never scrolls your terminal

`peek` always reads `--source visible`, and that is not configurable.

herdr's own default for `pane read` is `--source recent`, which asks for
scrollback — and on an idle agent herdr services that by **driving the pane's own
mouse-scroll**. The operator watches their real terminal scroll up and snap back,
once per read. It is also slow: a 400-line `recent` text read measured 13.8s
against ~0.1s for `visible`.

A read that moves the thing being read is not a read, so there is no
`--scrollback` flag here. `visible` is the rendered viewport, clamped, immune by
construction. The cost is real and worth stating: what scrolled off the top is
not reachable through `peek`. `--lines` only trims the viewport it already has,
so for an agent whose UI ends in a status bar, ask for more lines (40 is the
default) to reach the actual answer above it.

## `--json` shape

`mode` names which listing you asked for.

```json
{
  "command": "ls",
  "mode": "workspaces",
  "scope": "herdr",
  "json": true,
  "workspaces": [
    { "session": "default", "id": "wD", "label": "neo-oracle", "panes": 4,
      "tabs": 2, "status": "working", "focused": true, "repo": "neo-oracle",
      "checkout": "/opt/Code/github.com/laris-co/neo-oracle", "linked": false }
  ]
}
```

`ls --sessions --json` keeps the original envelope — `mode: "sessions"` and a
`sessions` array of `{session, status, panes, agents}`, `status` being `active`
or `stale`, the default session carrying `"default": true`. A stale session
reports zero panes and agents; herdr cannot count what is not running.

`ls --agents --json` sets `mode` to `"agents"` and carries an `agents` array of
`{session, pane, agent, name, status, workspace, tab, tabLabel, focused, cwd}`.
`peek --json` answers `{command, pane, session, workspace, agent, status,
source, lines, text}` — `source` is always `"visible"`.

Agent names are joined in from `snapshot.agents[]` by `pane_id`; a pane carries
no name field of its own.

The roster is built from `herdr api snapshot`, never from `agent list`:
`agent list` returns one row per agent and so collapses a split tab into a single
entry (25 agents against the snapshot's 28 panes on the same machine). The
snapshot also carries `tab_id` and `workspace_id`, which is what makes a
workspace label usable as a target at all.

## Interactive attach

`plugin.json` sets `cli.interactive: true`, which asks maw to hand the terminal's
stdin to the plugin so herdr's full-screen TUI can run under `maw herdr a`.
That flag lands in maw-rs with
[#992](https://github.com/Soul-Brews-Studio/maw-rs/issues/992). On an older maw
the plugin sees no terminal and refuses with the exact `herdr --session …`
command to run yourself; `maw herdr a <session> --print` works everywhere.

## Traps

**herdr and tmux are sibling multiplexers, not layers.** herdr cannot see tmux
panes and maw cannot see herdr panes: `maw ls` and `maw herdr ls` describe two
disjoint worlds, and no maw verb (`maw hey`, `maw run`, `maw split`) reaches
into a herdr pane — `maw herdr hey` exists precisely because `maw hey` cannot. Both also default to prefix `ctrl+b`, so when one is nested
in the other you are guessing which multiplexer swallowed the keystroke — set a
different `prefix` in herdr's `config.toml` before nesting them.

## Smoke

```bash
just local smoke                  # here
just remote smoke god@white.local # there
```

Runs against the *installed* plugin through `maw herdr …`, so it needs `maw`
on `PATH` with this plugin installed. It checks `help`, all three `ls --json` shapes, attach `--print` on a real
session, both attach error paths, that `wake --dry-run` plans a workspace and
only `--own-session` plans a server, and that `hey --dry-run` and an unknown
`peek` target resolve without sending or reading anything. When `maw` or
`herdr` is absent it prints a `SKIP:` line and exits 0, so it is safe in CI.
