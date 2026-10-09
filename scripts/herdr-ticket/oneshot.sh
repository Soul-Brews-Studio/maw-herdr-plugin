#!/usr/bin/env bash
# oneshot.sh — kept so commands printed before 2026-10-08 14:30 still work. Everything lives in ticket.sh now:
# `oneshot.sh pick N` = `ticket.sh pick N --oneshot`; continue / open / status are passed through unchanged.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ "${1:-}" = pick ]; then exec bash "$here/ticket.sh" "$@" --oneshot; fi
exec bash "$here/ticket.sh" "$@"
