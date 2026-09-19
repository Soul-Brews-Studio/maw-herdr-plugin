# Isolated server development: no install/deploy or real Herdr mutations.
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
