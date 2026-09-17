# Another machine, over ssh. Same clean-tree staging as `local install`:
# the tree that crosses the wire is `git archive` output, never the checkout.

set working-directory := '..'

import '00-common.just'

default:
    @just --list remote

# ship a clean tree and install it there
install host: (_ship host)
    @ssh {{ host }} 'maw plugin install {{ remote_stage }} --root ~/.maw/plugins --force && maw plugin ls | grep -E "^herdr" || true'

# install there, then prove it works there
up host: (install host) (smoke host)

# run the smoke suite on the remote, against what is installed there
smoke host:
    @ssh {{ host }} 'cd {{ remote_stage }} && bash smoke.sh'

# what the plugin sees there
ls host:
    @ssh {{ host }} 'maw herdr ls && echo && maw herdr ls --agents'

# copy the staged tree across; scp, never rsync -L — the tree is already clean
# and -L would re-create the very dereferencing the staging exists to avoid.
[private]
_ship host:
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(just local::_stage)
    trap 'rm -rf "$stage"' EXIT
    ssh {{ host }} 'rm -rf {{ remote_stage }} && mkdir -p {{ remote_stage }}'
    scp -q -r "$stage"/. {{ host }}:{{ remote_stage }}/
