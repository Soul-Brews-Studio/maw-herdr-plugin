# This machine: validate, install, smoke.
#
# `set working-directory` is load-bearing. A `mod` recipe runs with its cwd set
# to the MODULE FILE's directory, so a bare `node --check index.mjs` here would
# look inside just/ and fail on a file that is not missing. `import` does not
# move the cwd; `mod` does.

set working-directory := '..'

import '00-common.just'

default:
    @just --list local

# parse everything that ships, before anything is installed
check:
    @node --check index.mjs && echo "ok: index.mjs parses"
    @bash -n smoke.sh && echo "ok: smoke.sh parses"
    @python3 -c "import json;d=json.load(open('plugin.json'));print('ok: plugin.json valid, version',d['version'])"

# NEVER `maw plugin install .` from this checkout. If the repo has been through
# /incubate it holds a `ψ` symlink into the oracle vault, and that vault holds
# `incubate/<owner>/<repo>/origin` symlinks back to this repo and to every other
# incubated repo — a cycle. The installer dereferences it and walks forever:
# measured 3.5 GB written before it was killed, leaving the installed plugin
# with no index.mjs at all. `git archive` emits tracked files only, so there is
# no ψ, no .git and no .claude for it to walk into.

# install into the plugin root, from a clean tree
install: check
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(just local::_stage)
    trap 'rm -rf "$stage"' EXIT
    maw plugin install "$stage" --root "{{ plugin_root }}" --force
    maw plugin ls | grep -E '^herdr' || true

# run the smoke suite against whatever is installed
smoke:
    @bash smoke.sh

# stage a clean tree and print its path — the one place the ψ trap is avoided
[private]
_stage:
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-plugin.XXXXXX")
    git archive --format=tar HEAD | tar -x -C "$stage"
    # uncommitted work should still be installable while iterating
    cp index.mjs plugin.json README.md CHANGELOG.md smoke.sh "$stage/"
    printf '%s' "$stage"

# what the installed plugin sees here
ls:
    @maw herdr ls
    @echo
    @maw herdr ls --agents
