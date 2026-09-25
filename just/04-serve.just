# Server development checks are isolated; install explicitly updates local plugins.
set working-directory := '..'

# Fast Bun-only build and isolated runtime smoke; no Go compiler required.
bun-check:
    #!/usr/bin/env bash
    set -euo pipefail
    output=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-bun.XXXXXX")
    trap 'rm -rf "$output"' EXIT
    bun build index.mjs --target=bun --outfile "$output/index.js"
    bun utils/smoke-target-grammar.mjs
    MAW_TARGET_ENTRY="$output/index.js" bun utils/smoke-target-grammar.mjs
    bun utils/smoke-bun-serve.mjs
    bun utils/smoke-federation-config.ts
    node utils/smoke-federation-serve.mjs
    bun utils/smoke-maw-config.ts
    node utils/smoke-config-serve.mjs
    node utils/smoke-state-serve.mjs
    node utils/smoke-inbox-serve.mjs
    bun utils/smoke-registry-wake.ts
    node utils/smoke-registry-serve.mjs
    MAW_TEST_WAKE_ENGINE=claude node utils/smoke-registry-serve.mjs
    bun utils/smoke-task-plan.ts
    node utils/smoke-task-serve.mjs
    bun utils/smoke-wake-launch.ts
    bun utils/smoke-wake-hooks.ts
    bun utils/smoke-wake-fleet.ts
    bun utils/smoke-receiver-inbox.ts
    bun utils/smoke-delivery-dedup.ts
    bun utils/smoke-delivery-feed.ts
    bun utils/smoke-feed-activity.ts
    bun utils/smoke-wake-identity.ts
    node utils/smoke-launch-serve.mjs
    node utils/smoke-wake-finalize.mjs
    MAW_REGISTRY_ENTRY="$output/index.js" node utils/smoke-registry-serve.mjs
    MAW_TEST_WAKE_ENGINE=claude MAW_REGISTRY_ENTRY="$output/index.js" node utils/smoke-registry-serve.mjs
    MAW_TASK_ENTRY="$output/index.js" node utils/smoke-task-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-launch-serve.mjs
    MAW_LAUNCH_ENTRY="$output/index.js" node utils/smoke-wake-finalize.mjs
    MAW_CONFIG_ENTRY="$output/index.js" node utils/smoke-config-serve.mjs
    MAW_STATE_ENTRY="$output/index.js" node utils/smoke-state-serve.mjs
    MAW_INBOX_ENTRY="$output/index.js" node utils/smoke-inbox-serve.mjs
    MAW_FEDERATION_ENTRY="$output/index.js" node utils/smoke-federation-serve.mjs
    bun utils/smoke-terminal-serve.mjs
    MAW_TERMINAL_ENTRY="$output/index.js" bun utils/smoke-terminal-serve.mjs
    bun utils/smoke-terminal-limits.ts
    node utils/smoke-ls-path-help.mjs
    MAW_LS_ENTRY="$output/index.js" node utils/smoke-ls-path-help.mjs
    bun utils/smoke-send-composer.ts
    bun utils/smoke-send-watch.ts
    node utils/smoke-send-delivery.mjs
    MAW_SEND_ENTRY="$output/index.js" node utils/smoke-send-delivery.mjs
    node utils/smoke-mcp-serve.mjs
    MAW_MCP_ENTRY="$output/index.js" node utils/smoke-mcp-serve.mjs
    node utils/smoke-ls-states.mjs
    MAW_STATES_ENTRY="$output/index.js" node utils/smoke-ls-states.mjs

# The server is TypeScript on Bun; check is the Bun suite.
check: bun-check

# Build an installable package; no compiler, no native helper.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-package.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    os=$(node -p 'process.platform')
    arch=$(node -p '({x64:"amd64",arm64:"arm64"})[process.arch] || "unsupported"')
    node utils/package-serve.mjs --os "$os" --arch "$arch" --out "$stage/plugin"
    node utils/smoke-serve-package.mjs "$stage/plugin"
    maw plugin install "$stage/plugin" --root "$HOME/.maw/plugins" --force
