# oneshot-view.jq — `claude -p --output-format stream-json --verbose` → lines a human can watch.
# Used by oneshot-run.sh with `jq --unbuffered -rj`; every branch ends its own line.
def clip($n): if length > $n then .[0:$n] + "…" else . end;
def flat: gsub("\\s+"; " ");
def arg: (.command // .file_path // .path // .pattern // .url // .skill // .description // .prompt // "")
         | tostring | flat | clip(140);

if .type == "system" and .subtype == "init" then
  "▶ session \(.session_id[0:8]) · \(.model) · \(.permissionMode // "default") · \(.cwd)\n"
elif .type == "assistant" then
  [ (.message.content // [])[]
    | if .type == "text" then (.text | clip(1500)) + "\n"
      elif .type == "tool_use" then "  ⚙ \(.name) \(.input | arg)\n"
      else empty end ] | join("")
elif .type == "user" then
  ( .message.content
    | if type == "array" then
        [ .[] | select(.type == "tool_result" and .is_error == true)
          | "  ✗ \((.content | if type == "array" then (map(.text // "") | join(" ")) else tostring end) | flat | clip(160))\n" ]
        | join("")
      else "" end )
elif .type == "result" then
  "■ \(.subtype) · \(.num_turns) turns · $\(((.total_cost_usd // 0) * 100 | round) / 100) · \(((.duration_ms // 0) / 1000) | round)s"
  + (if ((.permission_denials // []) | length) > 0 then " · \(.permission_denials | length) permission denials" else "" end)
  + "\n"
else empty end
