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
