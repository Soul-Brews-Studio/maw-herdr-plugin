# Herdr plugin development

- Keep changes simple and dependency-free where the runtime provides the API.
- Every error ends with a copy-pasteable command that fixes it, real paths
  substituted, never a placeholder.
- `CLAUDE.md` is a relative symlink to this file, not a separate instruction copy.
- There is one server runtime: TypeScript on Bun. Native mode, `--runtime`,
  `--build` and `MAW_HERDR_SERVE_BIN` were removed; do not reintroduce a compiler
  step or an implicit build. The Go server is recoverable from git history.
- Keep the existing `runtime`, `target`, `entry`, and `engine.serve.command`
  contracts distinct. WASM guest support does not imply persistent HTTP/WebSocket
  support; do not invent a WASM server ABI or claim the new maw-cli hosts
  implement WASM dispatch.
- `engine.serve` runs Bun in every package. Preserve prefix/env validation, loopback peer/Host checks, and rejection of
  every browser Origin in engine mode. It trusts local processes and delegates
  remote authentication to the host gateway; never enable it from env alone.
- Standalone HTTP requires the private operator token even on loopback.
  Preserve exact Origin checks, single-use origin-bound expiring WS tickets,
  input/output/concurrency bounds, safe subprocess argv, and shutdown cleanup.
  Do not log credentials, silently create tokens, or operate live user sessions
  in tests. Sending reports acceptance, not agent completion.
- Preserve the documented API behavior; do not fabricate unsupported features.
  Bun may close oversized WS frames with 1006: verify rejection and zero prompt
  execution, not an identical transport close code.
- Build first, then actual-process source/bundle/package smokes. No new test
  framework/dependency without approval. Bun build transpiles; it is not
  TypeScript typechecking.
- Use issue -> feature branch -> PR into `main` -> verified merge. Release tags
  use `vYY.M.D-alpha.HMM` from the successful source CI creation time in Bangkok;
  retain exact commit/build provenance and never replace existing tags/assets.
- Keep Serena/CodeGraph indexes and learning artifacts private. Verify semantic
  lookups after changes; activation alone is not evidence of a working index.
