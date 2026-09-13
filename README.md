# maw-herdr-plugin

`maw herdr ls` and `maw herdr a` — the shape of `maw ls` and `maw a`, pointed at
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
into a herdr pane. Both also default to prefix `ctrl+b`, so when one is nested
in the other you are guessing which multiplexer swallowed the keystroke — set a
different `prefix` in herdr's `config.toml` before nesting them.

## Smoke

```bash
bash smoke.sh
```

Runs against the *installed* plugin through `maw herdr …`, so it needs `maw`
on `PATH` with this plugin installed. It checks `help`, the `ls --json` shape,
attach `--print` on a real session, and both attach error paths. When `maw` or
`herdr` is absent it prints a `SKIP:` line and exits 0, so it is safe in CI.
