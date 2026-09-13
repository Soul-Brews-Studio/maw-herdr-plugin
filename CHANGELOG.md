# Changelog

## 0.1.0 — 2026-09-13

- `maw herdr ls` / `maw herdr ls --json`: list herdr sessions with pane and
  agent counts, `--json` mirroring the `maw ls --json` envelope.
- `maw herdr a <session>` (alias `attach`), with `--print`: attach to a herdr
  session; targets resolve like `maw a` (exact, unique prefix, unique
  substring), ambiguity lists candidates, stopped and unknown sessions are
  refused.
- `cli.interactive: true` in the manifest so maw can inherit stdin for the TUI
  (maw-rs #992).
- `smoke.sh`, CI-safe: skips herdr-dependent checks when the binary is absent.
