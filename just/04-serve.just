# Server development checks are isolated; install explicitly updates local plugins.
set working-directory := '../server'

# Compile first, then run API tests and static checks.
check:
    #!/usr/bin/env bash
    set -euo pipefail
    output=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-build.XXXXXX")
    trap 'rm -rf "$output"' EXIT
    GOWORK=off go build -o "$output/maw-herdr-serve" .
    GOWORK=off go test ./...
    GOWORK=off go vet ./...

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
