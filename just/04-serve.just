# Server development checks are isolated; install explicitly updates local plugins.
set working-directory := '../server'

# Fast Bun-only build and isolated runtime smoke; no Go compiler required.
bun-check:
    #!/usr/bin/env bash
    set -euo pipefail
    cd ..
    output=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-bun.XXXXXX")
    trap 'rm -rf "$output"' EXIT
    bun build index.mjs --target=bun --outfile "$output/index.js"
    bun utils/smoke-bun-serve.mjs
    bun utils/smoke-federation-config.ts
    node utils/smoke-federation-serve.mjs
    bun utils/smoke-maw-config.ts
    node utils/smoke-config-serve.mjs
    bun utils/smoke-registry-wake.ts
    node utils/smoke-registry-serve.mjs
    bun utils/smoke-task-plan.ts
    node utils/smoke-task-serve.mjs
    bun utils/smoke-wake-launch.ts
    bun utils/smoke-wake-hooks.ts
    bun utils/smoke-wake-fleet.ts
    bun utils/smoke-wake-identity.ts
    node utils/smoke-launch-serve.mjs
    node utils/smoke-wake-finalize.mjs
    MAW_REGISTRY_ENTRY="$output/index.js" node utils/smoke-registry-serve.mjs
    MAW_TASK_ENTRY="$output/index.js" node utils/smoke-task-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-launch-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-wake-finalize.mjs
    MAW_CONFIG_ENTRY="$output/index.js" node utils/smoke-config-serve.mjs
    MAW_FEDERATION_ENTRY="$output/index.js" node utils/smoke-federation-serve.mjs
    bun utils/smoke-terminal-serve.mjs
    MAW_TERMINAL_ENTRY="$output/index.js" bun utils/smoke-terminal-serve.mjs
    bun utils/smoke-terminal-limits.ts

# Compile first, then run API tests and static checks.
check:
    #!/usr/bin/env bash
    set -euo pipefail
    output=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-build.XXXXXX")
    trap 'rm -rf "$output"' EXIT
    GOWORK=off go build -o "$output/maw-herdr-serve" .
    GOWORK=off go test ./...
    GOWORK=off go vet ./...
    cd ..
    bun build index.mjs --target=bun --outfile "$output/index.js"
    bun utils/smoke-terminal-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-federation-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-config-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-registry-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-task-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-launch-serve.mjs "$output/maw-herdr-serve"
    node utils/smoke-wake-finalize.mjs "$output/maw-herdr-serve"
    node utils/smoke-serve-launcher.mjs
    bun utils/smoke-bun-serve.mjs
    bun utils/smoke-federation-config.ts
    node utils/smoke-federation-serve.mjs
    bun utils/smoke-maw-config.ts
    node utils/smoke-config-serve.mjs
    bun utils/smoke-registry-wake.ts
    node utils/smoke-registry-serve.mjs
    bun utils/smoke-task-plan.ts
    node utils/smoke-task-serve.mjs
    bun utils/smoke-wake-launch.ts
    bun utils/smoke-wake-hooks.ts
    bun utils/smoke-wake-fleet.ts
    bun utils/smoke-wake-identity.ts
    node utils/smoke-launch-serve.mjs
    node utils/smoke-wake-finalize.mjs
    MAW_REGISTRY_ENTRY="$output/index.js" node utils/smoke-registry-serve.mjs
    MAW_TASK_ENTRY="$output/index.js" node utils/smoke-task-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-launch-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-wake-finalize.mjs
    MAW_CONFIG_ENTRY="$output/index.js" node utils/smoke-config-serve.mjs
    MAW_FEDERATION_ENTRY="$output/index.js" node utils/smoke-federation-serve.mjs
    bun utils/smoke-terminal-serve.mjs
    MAW_TERMINAL_ENTRY="$output/index.js" bun utils/smoke-terminal-serve.mjs
    bun utils/smoke-terminal-limits.ts

# Build an installable native package; normal installed use does not need Go.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd ..
    stage=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-package.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    os=$(node -p 'process.platform')
    arch=$(node -p '({x64:"amd64",arm64:"arm64"})[process.arch] || "unsupported"')
    node utils/package-serve.mjs --os "$os" --arch "$arch" --out "$stage/plugin"
    node utils/smoke-serve-package.mjs "$stage/plugin"
    maw plugin install "$stage/plugin" --root "$HOME/.maw/plugins" --force
