# maw-herdr-plugin — herdr through maw's own verbs.
#
# One module per place the plugin can live. Every recipe here is idempotent and
# reversible — reinstalling is the undo — so nothing is CONFIRM-gated. If a
# recipe is ever added that is not (an uninstall, a registry push), gate it the
# way the fleet's deploy repo does: refuse without CONFIRM=yes, and print what
# it would have done.
#
#   just local install               install here
#   just remote up god@white.local   install there, then smoke it
#   just fleet status                what every machine has, and what it is missing
#   just fleet install               install onto every machine that can take it
#   just status god@white.local      versions, here and there
#   just --list local                one module's recipes

mod local  'just/01-local.just'
mod remote 'just/02-remote.just'
mod fleet  'just/03-fleet.just'

default:
    @just --list

# check + install + smoke, here
all:
    @just local check
    @just local install
    @just local smoke

# what is installed, here and optionally there
status host="":
    #!/usr/bin/env bash
    set -uo pipefail
    echo "checkout: $(python3 -c "import json;print(json.load(open('plugin.json'))['version'])")"
    echo "here:"
    maw plugin info herdr 2>/dev/null | sed -n '1,4p' | sed 's/^/  /' || echo "  not installed"
    if [ -n "{{ host }}" ]; then
      echo "{{ host }}:"
      ssh {{ host }} 'maw plugin info herdr 2>/dev/null | sed -n "1,4p" | sed "s/^/  /" || echo "  not installed"'
    fi
