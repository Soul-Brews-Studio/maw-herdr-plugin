# maw-herdr-plugin

`maw herdr ls`, `a`, `wake`, `hey` and `peek` — the shape of maw's own verbs, pointed at
[herdr](https://herdr.dev), the terminal multiplexer for AI coding agents. The
plugin shells out to the `herdr` binary and reshapes its output into maw's own
session listing, so the muscle memory is the same whichever multiplexer a
session lives in.

Dev-tier JS plugin (`runtime: "bun-dev"`, `target: "js"`; `maw plugin ls`
files it under the `extra` tier). `plugin.json` declares one capability,
`proc:exec:herdr` — no credentials, no filesystem access, no network. When you
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
From a local clone: `maw plugin install /path/to/maw-herdr-plugin --root ~/.maw/plugins`
(add `--force` to overwrite an existing install).

## Requirements

- `herdr` on `PATH` (verified against herdr 0.9.0). Without it, `maw herdr help`
  still works and everything else exits non-zero.
- `bun`, because maw runs dev-tier plugins with bun.

## Verbs

```bash
maw herdr ls                    # list sessions with pane and agent counts
maw herdr ls --json             # same, as JSON
maw herdr a <session>           # attach (alias: maw herdr attach)
maw herdr a <session> --print   # print the herdr command instead of running it
maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]
maw herdr ls --agents           # every agent pane across every running session
maw herdr hey <target> <msg>    # submit a prompt to an agent   [--dry-run]
maw herdr peek <target>         # read what an agent's pane shows  [--lines N] [--json]
```

`ls` marks each session `●` active or `◌` stale.

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

`maw herdr wake <oracle>` is `maw wake` for herdr: it gives the oracle its own
herdr session (named after the repo, e.g. `neo` → `neo-oracle`, the convention
the fleet already uses), creates a workspace in the oracle's checkout, and
starts the agent there — `herdr agent start <name> --kind <engine>`, so
`--engine` takes any herdr agent kind (`claude` by default, `codex`, `gemini`,
…). Waking an oracle that is already awake reports the existing agent instead
of starting a second one.

The target is resolved from `~/.maw/oracles.json`: a registry `name`, an
`org/repo` (needed when a name is reused across orgs — the registry has such
collisions), or a directory. `--dry-run` prints the herdr commands it would run;
`--prompt` sends a first prompt; `--attach` attaches afterwards (needs a
terminal — see below).

```bash
maw herdr wake neo --dry-run
maw herdr wake laris-co/neo-oracle --engine codex
maw herdr wake neo --prompt "recap the last session" --attach
```

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

### Targets are workspace labels, because agent names are not there

`<target>` resolves in tiers: pane id, agent name, workspace label, tab label,
then a unique prefix or substring of the workspace label.

**In practice the workspace label is the only handle that exists.** On the fleet
machine this was written against, **0 of 28 panes carried an `agent_name`** — so
a design built on names would have addressed nothing. Workspace labels are the
oracle names the fleet already uses (`digger-oracle`, `pulse-oracle`), which is
why `maw herdr hey digger …` works and reads like `maw hey`.

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

Mirrors `maw ls --json`:

```json
{
  "command": "ls",
  "mode": "compact",
  "scope": "herdr",
  "json": true,
  "sessions": [
    { "session": "main", "status": "active", "panes": 3, "agents": 1 }
  ]
}
```

`status` is `active` or `stale`. The default session carries an extra
`"default": true`. A stale session reports zero panes and agents — herdr cannot
count what is not running.

`ls --agents --json` swaps `mode` to `"agents"` and carries an `agents` array of
`{session, pane, agent, name, status, workspace, tab, tabLabel, focused, cwd}`.
`peek --json` answers `{command, pane, session, workspace, agent, status,
source, lines, text}` — `source` is always `"visible"`.

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
bash smoke.sh
```

Runs against the *installed* plugin through `maw herdr …`, so it needs `maw`
on `PATH` with this plugin installed. It checks `help`, the `ls --json` and `ls --agents --json` shapes, attach
`--print` on a real session, both attach error paths, and that `hey --dry-run`
and an unknown `peek` target resolve without sending or reading anything. When `maw` or
`herdr` is absent it prints a `SKIP:` line and exits 0, so it is safe in CI.
