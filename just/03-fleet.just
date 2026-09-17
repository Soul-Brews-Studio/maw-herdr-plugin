# Every machine that could run this plugin, and getting it onto them.
#
# A "machine" in `herdr machine list` is really a (host, USER) pair, and that is
# not cosmetic: measured 2026-09-17, `white.local` and `god` are the same host
# under different users — one has herdr on PATH and the other does not — and
# `nm@white.local` is a third user on it again, carrying a stale herdr@0.1.0.
# So the fleet list is ssh targets, never hostnames.

set working-directory := '..'

import '00-common.just'

# ssh targets to consider. Defaults to herdr's own machine list plus this host.
# Override for a fleet herdr has never been told about:  HERDR_FLEET="a b c" just fleet status
fleet := env_var_or_default("HERDR_FLEET", "")

default:
    @just --list fleet

# Two stdin traps, both of which silently truncate the loop rather than erroring.
# ssh reads stdin by default, so an ssh inside `while read` eats the remaining
# targets: measured, the loop ran ONCE. `-n` fixes the ones we call directly —
# but `just remote install` shells out to its own ssh and scp, which we do not
# control from here. So the list is read into a variable FIRST and the loop
# iterates over that, never over a live pipe.

# resolve the target list once, so status and install always agree
[private]
_targets:
    #!/usr/bin/env bash
    set -uo pipefail
    if [ -n "{{ fleet }}" ]; then
        printf '%s\n' {{ fleet }}
    else
        herdr machine list 2>/dev/null | awk -F'\t' 'NF>2 && $5!="disabled" {print $3}'
    fi

# what every target has, and what it is missing
status:
    #!/usr/bin/env bash
    set -uo pipefail
    probe='
    h=$(hostname -s 2>/dev/null); os=$(uname -s)
    t=""; for c in maw herdr bun just node python3; do command -v $c >/dev/null && t="$t$c "; done
    v=$(maw plugin info herdr 2>/dev/null | head -1)
    s=$(herdr session list --json 2>/dev/null | python3 -c "import json,sys;print(sum(1 for x in json.load(sys.stdin)[\"sessions\"] if x[\"running\"]))" 2>/dev/null)
    echo "$h|$os|$t|${v:-none}|${s:-?}"
    '
    printf "%-22s %-12s %-6s %-34s %-14s %s\n" TARGET HOST OS TOOLS PLUGIN "RUNNING SESSIONS"
    targets=$(just fleet _targets)
    for t in $targets; do
        [ -z "$t" ] && continue
        out=$(timeout 20 ssh -n -o ConnectTimeout=6 -o BatchMode=yes "$t" "$probe" 2>/dev/null | tail -1)
        if [ -z "$out" ]; then printf "%-22s %s\n" "$t" "unreachable"; continue; fi
        IFS='|' read -r h os tools ver sess <<< "$out"
        printf "%-22s %-12s %-6s %-34s %-14s %s\n" "$t" "$h" "$os" "$tools" "$ver" "$sess"
    done

# install onto every target that can take it; say why the others are skipped
install:
    #!/usr/bin/env bash
    set -uo pipefail
    targets=$(just fleet _targets)
    for t in $targets; do
        [ -z "$t" ] && continue
        why=$(timeout 20 ssh -n -o ConnectTimeout=6 -o BatchMode=yes "$t" '
            command -v maw   >/dev/null || { echo "no maw";   exit 0; }
            command -v herdr >/dev/null || { echo "no herdr"; exit 0; }
            command -v bun   >/dev/null || { echo "no bun";   exit 0; }
            echo ok' 2>/dev/null | tail -1)
        case "${why:-unreachable}" in
            ok) printf "  → %s\n" "$t"
                if just remote install "$t" >/dev/null 2>&1; then
                    printf "    %s\n" "$(ssh -n "$t" 'maw plugin info herdr 2>/dev/null | head -1')"
                else
                    printf "    install FAILED\n"
                fi ;;
            *)  printf "  ⊘ %-20s %s\n" "$t" "$why" ;;
        esac
    done

# smoke every target that has the plugin
smoke:
    #!/usr/bin/env bash
    set -uo pipefail
    targets=$(just fleet _targets)
    for t in $targets; do
        [ -z "$t" ] && continue
        r=$(timeout 60 ssh -n -o ConnectTimeout=6 -o BatchMode=yes "$t" 'cd {{ remote_stage }} 2>/dev/null && bash smoke.sh 2>&1 | tail -1' 2>/dev/null)
        printf "  %-22s %s\n" "$t" "${r:-not installed from here}"
    done
