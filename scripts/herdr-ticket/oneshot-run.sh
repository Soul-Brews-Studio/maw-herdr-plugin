#!/usr/bin/env bash
# oneshot-run.sh — kept for panes started before 2026-10-08 14:30; the runner is ticket-run.sh now.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ticket-run.sh" "$@"
