# Herdr plugin development

- Keep changes simple and dependency-free where the runtime provides the API.
- `CLAUDE.md` is a relative symlink to this file, not a separate instruction copy.
- Runtime selection belongs to the plugin, not the language of its maw host.
  Standalone `serve` defaults to Bun/TypeScript. Native mode is explicit via
  `--runtime native`, `--build`, or `MAW_HERDR_SERVE_BIN`. Never compile implicitly.
- Keep the existing `runtime`, `target`, `entry`, and `engine.serve.command`
  contracts distinct. A native helper can be written in any language. WASM guest
  support does not imply persistent HTTP/WebSocket support; do not invent a
  WASM server ABI or claim the new maw-cli hosts implement WASM dispatch.
- Source `engine.serve` runs Bun; native packages explicitly select their helper.
  Preserve prefix/env validation, loopback peer/Host checks, and rejection of
  every browser Origin in engine mode. It trusts local processes and delegates
  remote authentication to the host gateway; never enable it from env alone.
- Standalone HTTP requires the private operator token even on loopback.
  Preserve exact Origin checks, single-use origin-bound expiring WS tickets,
  input/output/concurrency bounds, safe subprocess argv, and shutdown cleanup.
  Do not log credentials, silently create tokens, or operate live user sessions
  in tests. Sending reports acceptance, not agent completion.
- Preserve core Go/Bun API behavior; do not fabricate unsupported features.
  Bun may close oversized WS frames with 1006 rather than Go's 1009: verify
  rejection and zero prompt execution, not an identical transport close code.
- Compile first, then actual-process source/bundle/native-package smokes and
  existing Go tests/vet. No new test framework/dependency without approval.
  Bun build transpiles; it is not TypeScript typechecking.
- Use issue -> feature branch -> PR into `main` -> verified merge. Release tags
  use `vYY.M.D-alpha.HMM` from the successful source CI creation time in Bangkok;
  retain exact commit/build provenance and never replace existing tags/assets.
- Keep Serena/CodeGraph indexes and learning artifacts private. Verify semantic
  lookups after changes; activation alone is not evidence of a working index.
