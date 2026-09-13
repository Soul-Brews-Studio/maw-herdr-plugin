# Changelog

## 0.1.0 — 2026-09-13

- `maw herdr ls` / `maw herdr ls --json`: list herdr sessions with pane and
  agent counts, `--json` mirroring the `maw ls --json` envelope.
- `maw herdr a <session>` (alias `attach`), with `--print`: attach to a herdr
  session; targets resolve like `maw a` (exact, unique prefix, unique
  substring), ambiguity lists candidates, stopped and unknown sessions are
  refused. Usage mistakes exit 2, lookup failures exit 1, like `maw a`.
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
