#!/usr/bin/env bash
# ticket-run.sh — the half of /herdr-ticket that runs INSIDE the worktree's pane.
#
#   ticket-run.sh agent    <worktree> <session-uuid> [--model m] [--permission-mode p]
#       stateful: exec an interactive claude whose first prompt is the brief; it stays open in this pane
#   ticket-run.sh start    <worktree> <session-uuid> [--model m] [--permission-mode p] [--notify pane]
#       one-shot: one `claude -p` turn, streamed readably, raw stream + result kept in the worktree's git dir
#   ticket-run.sh continue <worktree> <session-uuid> --message-file <f> [same options]
#       one-shot follow-up on the same session (`claude -p --resume`)
#
# State: <repo>/.git/worktrees/<id>/oneshot/ (brief.md, run-<ts>.jsonl, result.json, pid) — never in the diff.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ $# -ge 3 ] || { sed -n '4,9p' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2; exit 2; }
mode=$1 dest=$2 U=$3; shift 3
MODEL="" PERM="" NOTIFY="" MSGFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL=$2; shift 2 ;;
    --permission-mode) PERM=$2; shift 2 ;;
    --notify) NOTIFY=$2; shift 2 ;;
    --message-file) MSGFILE=$2; shift 2 ;;
    *) echo "✗ unknown argument $1" >&2; exit 2 ;;
  esac
done

cd "$dest" || { echo "✗ no such worktree: $dest"; exit 1; }
state="$(git rev-parse --absolute-git-dir)/oneshot"; mkdir -p "$state"
again="bash $(printf %q "$here/ticket.sh")"

# one writer per session: an open `claude --resume` or a running one-shot would interleave the transcript
if claude agents --json 2>/dev/null | jq -e --arg u "$U" 'any(.[]?; .sessionId == $u)' >/dev/null 2>&1; then
  echo "✗ session $U is open in another claude right now"; echo "  claude attach ${U:0:8}"; exit 1
fi
if [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null; then
  echo "✗ a one-shot is already running in this worktree (pid $(cat "$state/pid"))"; echo "  $again status $(printf %q "$dest")"; exit 1
fi

# herdr's claude hook (~/.claude/hooks/herdr-agent-state.sh) reports this run's session for $HERDR_PANE_ID. In the
# worktree's own pane that is right; run from another agent's shell it would re-label THAT agent's pane with this
# session (seen 2026-10-08), so hide herdr from the child there.
hide=()
if [ -n "${HERDR_PANE_ID:-}" ]; then
  pc=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.pane.cwd // empty')
  case "$pc" in "$dest"|"$dest"/*) ;; *) hide=(-u HERDR_ENV -u HERDR_PANE_ID) ;; esac
fi
clean=(env ${hide[@]+"${hide[@]}"} -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION
       -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID
       -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN)

if [ "$mode" = agent ]; then
  [ -s "$state/brief.md" ] || { echo "✗ no brief at $state/brief.md"; exit 1; }
  args=(--session-id "$U")
  [ -n "$MODEL" ] && args+=(--model "$MODEL")
  [ -n "$PERM" ] && args+=(--permission-mode "$PERM")
  # direnv exec: the token comes from THIS worktree's .envrc, not from whatever the pane's shell loaded
  exec direnv exec "$dest" "${clean[@]}" claude "${args[@]}" "$(cat "$state/brief.md")"
fi

echo $$ > "$state/pid"; trap 'rm -f "$state/pid"' EXIT
case "$mode" in
  start) input="$state/brief.md"; sess=(--session-id "$U") ;;
  continue) input=$MSGFILE; sess=(--resume "$U") ;;
  *) echo "✗ mode must be agent, start or continue, got $mode"; exit 2 ;;
esac
[ -s "$input" ] || { echo "✗ no prompt at ${input:-<none>}"; exit 1; }

raw="$state/run-$(date +%Y%m%d-%H%M%S).jsonl"
args=(-p "${sess[@]}" --model "${MODEL:-sonnet}" --output-format stream-json --verbose)
[ -n "$PERM" ] && args+=(--permission-mode "$PERM")
printf '── %s · %s · session %s · %s\n' "$mode" "$(basename "$dest")" "${U:0:8}" "${MODEL:-sonnet}"

direnv exec "$dest" "${clean[@]}" claude "${args[@]}" < "$input" | tee "$raw" | jq --unbuffered -rj -f "$here/oneshot-view.jq"
rc=${PIPESTATUS[0]}

res=$(jq -c 'select(.type == "result")' "$raw" 2>/dev/null | tail -1)
if [ -n "$res" ]; then
  printf '%s\n' "$res" | jq --arg log "$raw" '{session_id, subtype, is_error, num_turns, duration_ms, total_cost_usd,
    permission_denials: ((.permission_denials // []) | length), result: ((.result // "") | .[0:4000]),
    log: $log, at: (now | todate)}' > "$state/result.json"
  [ "$(jq -r .is_error "$state/result.json")" = true ] && [ "$rc" = 0 ] && rc=1
fi

echo
echo "── rc=$rc · session $U"
echo "continue:  $again continue $(printf %q "$dest") \"<message>\""
echo "full:      cd $(printf %q "$dest") && direnv exec . claude --resume $U"

if [ -n "$NOTIFY" ]; then
  sum=$(jq -r '(.result // "") | gsub("\\s+"; " ") | .[0:300]' "$state/result.json" 2>/dev/null)
  cost=$(jq -r '(.total_cost_usd // 0) * 100 | round / 100' "$state/result.json" 2>/dev/null)
  herdr agent prompt "$NOTIFY" "[oneshot $(basename "$dest")] rc=$rc session=$U cost=\$${cost:-?} — ${sum:-no result}" >/dev/null 2>&1 \
    || echo "(could not notify $NOTIFY)"
fi
exit "$rc"
