# maw-herdr-plugin — herdr through maw's own verbs.
#
#   just              what you can do
#   just install      install into ~/.maw/plugins from a clean tree
#   just remote god@white.local      ship and install on another machine
#
# NEVER `maw plugin install .` from this checkout. If the repo has been through
# /incubate it holds a `ψ` symlink into the oracle vault, and that vault holds
# `incubate/<owner>/<repo>/origin` symlinks back to this repo and to every other
# incubated repo — a cycle. The installer dereferences it and walks forever:
# measured 3.5 GB written before it was killed, leaving the installed plugin
# with no index.mjs at all. `git archive` emits tracked files only, so there is
# no ψ, no .git and no .claude for it to walk into.

set shell := ["bash", "-uc"]

root := env_var_or_default("MAW_PLUGIN_ROOT", env_var("HOME") + "/.maw/plugins")

_default:
    @just --list --unsorted

# parse + shellcheck-lite, no install
check:
    @node --check index.mjs && echo "ok: index.mjs parses"
    @bash -n smoke.sh && echo "ok: smoke.sh parses"
    @python3 -c "import json,sys; d=json.load(open('plugin.json')); print('ok: plugin.json is valid, version', d['version'])"

# install here, from a clean tree
install: check
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-plugin.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    git archive --format=tar HEAD | tar -x -C "$stage"
    # uncommitted work should still be installable while iterating
    cp index.mjs plugin.json README.md CHANGELOG.md smoke.sh "$stage/"
    maw plugin install "$stage" --root "{{ root }}" --force
    maw plugin ls | grep -E '^herdr' || true

# run the smoke test against whatever is installed
smoke:
    @bash smoke.sh

install-and-smoke: install smoke

# ship a clean tree to another machine and install it there
remote host:
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d "${TMPDIR:-/tmp}/maw-herdr-plugin.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    git archive --format=tar HEAD | tar -x -C "$stage"
    cp index.mjs plugin.json README.md CHANGELOG.md smoke.sh "$stage/"
    # -r, never -rL: the tree is already clean, and -L would re-create the very
    # dereferencing this file exists to avoid if anyone adds a symlink later.
    ssh {{ host }} 'rm -rf ~/.cache/maw-herdr-plugin && mkdir -p ~/.cache/maw-herdr-plugin'
    scp -q -r "$stage"/. {{ host }}:~/.cache/maw-herdr-plugin/
    ssh {{ host }} 'maw plugin install ~/.cache/maw-herdr-plugin --root ~/.maw/plugins --force && maw plugin ls | grep -E "^herdr" || true'

# smoke test on another machine, against what is installed there
remote-smoke host:
    @ssh {{ host }} 'cd ~/.cache/maw-herdr-plugin && bash smoke.sh'

# what the plugin sees on another machine
remote-ls host:
    @ssh {{ host }} 'maw herdr ls && echo && maw herdr ls --agents'

# what is installed, here and there
status host="":
    #!/usr/bin/env bash
    set -uo pipefail
    echo "local:  $(python3 -c "import json;print(json.load(open('plugin.json'))['version'])") in this checkout"
    maw plugin info herdr 2>/dev/null | sed -n '1,4p' | sed 's/^/        /' || echo "        not installed"
    if [ -n "{{ host }}" ]; then
        echo "{{ host }}:"
        ssh {{ host }} 'maw plugin info herdr 2>/dev/null | sed -n "1,4p" | sed "s/^/        /" || echo "        not installed"'
    fi
