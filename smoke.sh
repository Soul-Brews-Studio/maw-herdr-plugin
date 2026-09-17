#!/usr/bin/env bash
# herdr plugin smoke: help, ls --json shape, and both attach error paths.
# CI-safe — every check that needs the herdr binary is skipped when it is absent.
set -eu

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if ! command -v maw >/dev/null 2>&1; then
  echo "SKIP: maw not installed"
  exit 0
fi

# help never shells out to herdr, so it must work everywhere.
maw herdr help >/dev/null || fail "maw herdr help exited non-zero"
echo "ok: maw herdr help"

# A missing session name is rejected before herdr is ever invoked.
if maw herdr a >/dev/null 2>&1; then
  fail "maw herdr a (no argument) exited 0"
fi
echo "ok: maw herdr a (no argument) exits non-zero"

if ! command -v herdr >/dev/null 2>&1; then
  echo "SKIP: herdr not installed"
  exit 0
fi

maw herdr ls --json | node -e '
const out = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (!Array.isArray(out.sessions)) {
  console.error("ls --json has no sessions array");
  process.exit(1);
}
console.log(`ok: maw herdr ls --json (${out.sessions.length} session(s))`);
' || fail "maw herdr ls --json did not parse as JSON with a sessions array"

# Attach --print on a real active session must succeed and name the herdr command.
active=$(maw herdr ls --json | node -e '
const out = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const s = out.sessions.find(x => x.status === "active");
if (s) process.stdout.write(s.session);
')
if [ -n "$active" ]; then
  out=$(maw herdr a "$active" --print 2>&1) || fail "maw herdr a $active --print exited non-zero: $out"
  case "$out" in
    *herdr*) echo "ok: maw herdr a $active --print" ;;
    *) fail "attach --print did not print a herdr command: $out" ;;
  esac
else
  echo "SKIP: no active herdr session for attach --print"
fi

# wake --dry-run must plan without starting anything; needs an oracle registry.
if [ -f "$HOME/.maw/oracles.json" ]; then
  if oracle=$(node -e '
const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const o = (d.oracles || []).find(x => require("node:fs").existsSync(x.local_path));
if (o) process.stdout.write(o.org + "/" + o.repo);
' "$HOME/.maw/oracles.json") && [ -n "$oracle" ]; then
    before=$(maw herdr ls --json | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0,"utf8")).sessions.length))')
    out=$(maw herdr wake "$oracle" --dry-run 2>&1) || fail "maw herdr wake $oracle --dry-run exited non-zero: $out"
    case "$out" in
      *"agent start"*) echo "ok: maw herdr wake $oracle --dry-run plans an agent start" ;;
      *) fail "wake --dry-run printed no plan: $out" ;;
    esac
    after=$(maw herdr ls --json | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0,"utf8")).sessions.length))')
    [ "$before" = "$after" ] || fail "wake --dry-run changed the session count ($before -> $after)"
  else
    echo "SKIP: no oracle with a local checkout in ~/.maw/oracles.json"
  fi
else
  echo "SKIP: no ~/.maw/oracles.json for wake --dry-run"
fi

# ls --agents: shape only. Empty is a legitimate answer on a machine with no
# agent panes, so this asserts the envelope, never a count.
if command -v herdr >/dev/null 2>&1; then
  out=$(maw herdr ls --agents --json) || fail "maw herdr ls --agents --json exited non-zero"
  printf '%s' "$out" | node -e '
const d = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (d.mode !== "agents" || d.scope !== "herdr" || !Array.isArray(d.agents)) {
  console.error("bad envelope: " + JSON.stringify(d).slice(0, 200));
  process.exit(1);
}
for (const a of d.agents) {
  for (const k of ["session", "pane", "agent", "status", "workspace"]) {
    if (!(k in a)) { console.error("agent row missing " + k); process.exit(1); }
  }
}
' || fail "maw herdr ls --agents --json shape is wrong"
  echo "ok: maw herdr ls --agents --json shape"

  # hey --dry-run against the first listed pane: resolves and prints the herdr
  # call, sends nothing. Skipped when no agent pane exists.
  pane=$(printf '%s' "$out" | node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(d.agents[0]) process.stdout.write(d.agents[0].pane)')
  if [ -n "$pane" ]; then
    plan=$(maw herdr hey "$pane" smoke test --dry-run 2>&1) || fail "maw herdr hey --dry-run exited non-zero: $plan"
    case "$plan" in
      *"agent prompt $pane"*"nothing was sent"*) echo "ok: maw herdr hey --dry-run plans without sending" ;;
      *) fail "hey --dry-run printed no plan: $plan" ;;
    esac
  else
    echo "SKIP: no agent panes for hey --dry-run"
  fi

  # An unknown target must be refused before anything is read.
  if out=$(maw herdr peek __no_such_agent__ 2>&1); then
    fail "maw herdr peek __no_such_agent__ exited 0"
  fi
  case "$out" in
    *"no agent"*) echo "ok: maw herdr peek rejects an unknown target" ;;
    *) fail "unknown-agent error did not mention 'no agent': $out" ;;
  esac
else
  echo "SKIP: herdr not installed — ls --agents, hey, peek"
fi

# A missing message is a usage error, and never reaches herdr.
if maw herdr hey sometarget >/dev/null 2>&1; then
  fail "maw herdr hey with no message exited 0"
fi
echo "ok: maw herdr hey with no message is refused"

if out=$(maw herdr a __no_such_session__ 2>&1); then
  fail "maw herdr a __no_such_session__ exited 0"
fi
case "$out" in
  *"no herdr session"*)
    echo "ok: maw herdr a __no_such_session__ exits non-zero with 'no herdr session'"
    ;;
  *)
    fail "unknown-session error did not mention 'no herdr session': $out"
    ;;
esac

echo "herdr plugin smoke: rc=0"
