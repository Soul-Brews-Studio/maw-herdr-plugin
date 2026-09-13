# maw-herdr-plugin

`maw ls` and `maw a` for [herdr](https://herdr.dev), the terminal multiplexer for
AI coding agents. The plugin shells out to the `herdr` binary and reshapes its
output into maw's own session listing, so the muscle memory is the same
whichever multiplexer a session lives in.

Dev tier (`runtime: "bun-dev"`, `target: "js"`). The only capability it needs is
`proc:exec:herdr`: no credentials, no filesystem access, no network.

## Install

```bash
maw plugin install https://github.com/Soul-Brews-Studio/maw-herdr-plugin --root ~/.maw/plugins
maw plugin ls          # herdr should be listed, health: ok
maw herdr ls
```

From a local clone: `maw plugin install /path/to/maw-herdr-plugin --root ~/.maw/plugins`
(add `--force` to overwrite an existing install).

## Requirements

- `herdr` on `PATH` (verified against herdr 0.9.0). Without it, `maw herdr help`
  still works and everything else exits non-zero.
- `bun`, because this is a dev-tier plugin — `maw` runs it as `bun index.mjs`.

## Verbs

```bash
maw herdr ls                    # list sessions with pane and agent counts
maw herdr ls --json             # same, as JSON
maw herdr a <session>           # attach (alias: maw herdr attach)
maw herdr a <session> --print   # print the herdr command instead of running it
```

`ls` marks each session `●` active or `◌` stale.

`a` resolves the target the way `maw a` does: an exact name wins, then a unique
prefix, then a unique substring — `maw herdr a digger` attaches to
`digger-oracle` and prints `resolved: digger → digger-oracle`. Several matches
list the candidates and ask for the full name. A stopped session is refused, and
an unknown one lists the known names in the error.

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
[#992](https://github.com/Soul-Brews-Studio/maw-rs/issues/992); an older maw
ignores it, and `maw herdr a <session> --print` works everywhere.

## Traps

**herdr and tmux are sibling multiplexers, not layers.** herdr cannot see tmux
panes and maw cannot see herdr panes: `maw ls` and `maw herdr ls` describe two
disjoint worlds, and no maw verb (`maw hey`, `maw run`, `maw split`) reaches
into a herdr pane. Both also default to prefix `ctrl+b`, so a nested attach
leaves you guessing which multiplexer swallowed the keystroke — press the prefix
twice to pass it through to the inner one.

## Smoke

```bash
bash smoke.sh
```

Checks `help`, the `ls --json` shape, attach `--print` on a real session, and
both attach error paths. It prints `SKIP: herdr not installed` and exits 0 when
the binary is absent, so it is safe in CI.
