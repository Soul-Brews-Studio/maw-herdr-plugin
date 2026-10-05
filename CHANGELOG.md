# Changelog

## Unreleased

## 26.10.5-alpha.1200 — 2026-10-05

- Fix `a <name>` passing over a STOPPED herdr session named exactly `<name>` when other names merely
  contain it (#115): `maw a homekeeper` listed three closed `…-homekeeper-…` worktrees and never offered
  the stopped `homekeeper` session. An exact stopped-session name now loses only to an exact worktree or
  workspace name (exact label, org/repo, repo main, oracle name), as before (`charlie` still focuses the
  charlie workspace), and beats partial matches. Such a session is started, since `herdr --session <name>`
  launches it, after a [y/N] question (`-y` skips it), because herdr restores its spaces and by default
  resumes their agents. From inside herdr nothing is started: herdr does not launch within its own panes
  (`allow_nested = false`), so `a` prints the command to run from a terminal outside herdr. `--dry`/`--print`
  say what would run; a partial session name still never starts one. `utils/smoke-attach-focus.mjs`: 160
  checks.

## 26.10.5-alpha.1134 — 2026-10-05

- Fix `work` opening the space in herdr session `default` when run from a pane in another session (#113): it now uses the caller's session; outside herdr it still picks `default`.

## 26.10.5-alpha.715 — 2026-10-05

- Targets accept `org/repo` (#109), the form `maw locate` prints. `maw a soul-brews-studio/pulse-oracle`
  failed with "no herdr session … no worktree, workspace or pane matches"; only the clone's full path
  reached it, and `maw a pulse` took laris-co/pulse's exact label first. Now `org/repo`, in any case, is
  that clone's main worktree under a ghq root, found even with no space open and no `wt/`. It is a new
  name tier right after `exact label`, so every verb on the shared grammar gets it: `a`, `resolve`,
  `restart`, `resume`, `kill`, `close`, `watch`, `reply`. The same org/repo under two hosts lists both and
  does nothing. `hey`/`peek` keep their agent grammar. `utils/smoke-target-grammar.mjs`: 235 checks.

- New verb `handover` (#106), built on `wt`: `maw herdr handover <space> <oracle> [--issue N]
  [--engine claude|codex|omx] [--dry]`. It reads the space (repo from its origin, branch, clean?, agent idle?),
  runs `wt` in the oracle's repo (`maw locate`) with a brief whose first step is
  `/incubate <org>/<repo> --wt <slug>`, and closes the old space only when its checkout is clean AND its agent
  idle AND the new agent was briefed — otherwise it leaves the space open, says why and prints the close
  command. `utils/smoke-handover.mjs`: 38 checks against fake herdr/maw/gh — source and bundle.

- New verb `wt` (#106), the `/herdr-wt` flow from the CLI: `maw herdr wt <slug> [--base REF] [--issue N]
  [--engine claude|codex|omx] [--brief <text>] [--repo <path>] [--dry]`. It cuts
  `<repo>/wt/<slug>-<owner>[-issue<N>]-<bangkok day>` as a herdr worktree space from `origin/<default>` after a
  fetch (never `HEAD`: the main checkout may sit on someone's feature branch), locks it
  (`herdr|who@host|iso|slug[|#N]`), copies a missing `.envrc`, runs `maw token use "$(maw token resolve)"` (a note
  when nothing is assigned), makes `ψ/lab/<slug>/` where the worktree has a vault, then fires a throwaway
  `pane run` before the engine so direnv has loaded, waits for the engine (milliseconds), names the agent
  `<slug>-<owner>` (`<slug>` when that is over 32 characters) and, with `--issue`/`--brief`, comments the workspace
  on the issue and briefs the pane by id. It starts the engine through the pane's shell, never `agent start`, and
  reports a folder-trust or hooks question instead of answering it. It writes no issues. `--dry` runs only
  reads. `work` is unchanged. `utils/smoke-wt.mjs`: 68 checks with fake herdr/maw/gh on PATH, real git on
  throwaway repos with a bare origin — source and bundle.

## 26.10.3-alpha.2129 — 2026-10-03

- Fix `work` on a folder Claude Code has never opened (a fresh clone, a new worktree): herdr starts the
  engine but answers `agent start` with `agent_not_ready` while it waits at the folder-trust question,
  and `work` reported that as a failed start — "open … without an agent", exit 1 — found on the first
  live run (`maw work https://github.com/nat-build-with-oracle/oracle-office-town`). It now says the
  agent is waiting at a startup question, names the pane to answer it in (`maw herdr a <pane>`), holds a
  first prompt back with the `hey` command to send it after, and exits 0. It never answers the question:
  trusting a folder is a person's call. Any other refusal still fails. `utils/smoke-work.mjs`: 46 checks.

## 26.10.3-alpha.2117 — 2026-10-03

- New verb `work` (#101), the herdr port of maw-rs `maw work`: `maw herdr work <repo|.|path|url> [task]
  [--wt [slug]] [--engine <kind>] [--prompt <text>] [--attach] [--dry]`. A repo is a path, org/repo, a
  GitHub URL (repo, issue or pull) or a bare name under ghq; a URL that is not checked out is cloned with
  `ghq get` (`-p` for an ssh URL). A task gets the dashboard's task worktree — `<repo>/agents/<slug>` on
  `agents/<slug>`, space `<repo>-<slug>`, planned by the same `planTaskWorktree` — and an issue or pull URL
  names the task and becomes the agent's first prompt. A space already on that folder is reused, never
  doubled. With maw's default plugin set to herdr, plain `maw work …` reaches it. `--dry` plans every
  step and runs only `session list` and `pane list`. `utils/smoke-work.mjs`: 40 checks with fake herdr
  and ghq on PATH, real git on throwaway repos, no live session — source and bundle.

## 26.10.3-alpha.1026 — 2026-10-03

- Real-herdr smoke for join/break/layout/restore (#94): `utils/smoke-layout-live.mjs` checks exact
  geometry, pane id and terminal continuity, the duplicate-label refusal, and same-path restore
  then resume, on a throwaway herdr daemon with an unpaid stand-in agent; cleanup holds on SIGTERM.
- Live send coverage for #42: `utils/smoke-send-live.mjs` runs `POST /api/send` through the Bun
  server against a throwaway herdr daemon (`utils/lib.herdrDaemon.mjs`, stopped and deleted even on
  failure) with an unpaid stand-in agent — tagged delivery, busy-agent queueing, bounded Enter retry,
  draft/blocked refusals, honest receipts, dashboard WebSocket updates and delivery history.
- Fix `ls` and `resolve` counting a scratch repository under a dot-folder inside another
  checkout (`wt/<name>/.tmp/<repo>`) as a fleet repo (#92): its space duplicated the checkout
  label, so an exact name resolved to two worktrees. Scratch repos and their spaces are now
  excluded, not attributed to the containing checkout; repos opened outside any checkout and
  linked worktrees in hidden folders still count. `utils/smoke-scratch-repos.mjs`, 16 checks.
- Fix manifest/CLI help drift (#93): `plugin.json` help and description and the first `HELP`
  line now name every verb and alias (`list`, `read`, `here`, `back`, `fed`, …). A new smoke,
  `utils/smoke-help-verbs.mjs`, derives the verbs from the dispatch and rejects a missing or
  ghost verb, manifest drift, and any `--help` that reaches herdr — on source and bundle.

## 26.10.3-alpha.916 — 2026-10-03

- New verb `restore` and `ls restorable` (#90): list and bring back worktrees whose
  FOLDER is gone while the branch and the agent transcripts survive — invisible to
  resolve/ls/resume, which start from checkouts that exist. Listing starts from the
  transcripts through a new optional provider method `all({ contains })` (Claude: only
  `/wt/`-shaped project dirs, the head of each newest file; Codex: the existing single
  head scan), then two git calls per repo. `restore <name>` runs `git worktree add` at
  the SAME path (local branch, or `--track -b` from a remote; `-f` when git still
  registers the path), moves a folder that came back without `.git` aside and copies
  its files back, then hands over to `resume`. Refusals and `--dry` change nothing.
  Measured on a real machine: 30 restorable worktrees listed in 0.11 s.
- `ls --resumable` (any state written as a flag) now says states are words and prints
  `maw herdr ls resumable`, instead of a bare "unknown argument" (#90, Neo's review).
- `ls` no longer warns that "closed worktrees are missing from the counts" for a repo
  whose folder no longer exists — a pane sitting in a deleted scratch repo made every
  `ls` print that warning (#90, Neo's review).
- Internal: the layout verbs (#88) and the `self` check are split into one function per
  `src/cli/mod.<function>.mjs` file; no behaviour change.

- New verbs `join` (alias `here`), `break` (alias `back`), `layout` and `whoami` (#88).
  `join <target>...` moves agents' real panes into the caller's tab — no restart — with
  each share set inside the `pane move` (`--cols` default, `--rows`, `--main [--ratio R]`),
  never a resize afterwards. `break` moves panes to a new space named after the agent
  (or its repo folder), or `--into` an existing one as a new tab; a taken label is refused
  with the two commands that resolve it. `layout cols|rows|main` re-tiles the caller's tab
  through a scratch tab in the same workspace, where pane ids do not change. `whoami`
  prints the pane this really runs in. Every target is resolved before anything moves;
  `--dry` prints the exact herdr commands; `--tell` tells each moved agent its new id.
- Fix: `self` named the wrong pane after the caller's pane moved to another workspace.
  `HERDR_PANE_ID` is set when the pane's process starts and is not updated by `pane move`,
  so restart/resume/kill/close/watch defaulting to `self` addressed a pane id that no longer
  existed — or, once reused, another pane. `self` now checks the env against the process
  tree (`pane process-info`: the pane whose foreground group or shell is this process's or
  an ancestor's) and only overrides it on a positive match; a detached worker and every
  lookup failure keep the env value, as before. Inbox addresses keep the env id on purpose.

## 26.10.2-alpha.1609 — 2026-10-02

- Fix: `maw herdr a <target> --print` focused the pane when run inside herdr (it only
  printed when run outside). It now never acts: outside herdr it prints the attach
  command, inside it prints `maw herdr a --session <s> <pane>`. The bug shipped
  in 26.10.2-alpha.1101 (#84).

- `maw herdr a <name>` asks which one when the name is ambiguous and it runs in
  a terminal (stdin and stderr both TTYs, no `--dry`/`--print`): a numbered list
  and `pick 1-N (Enter cancels):`. A number continues as if that candidate had
  been typed; Enter, `q`, EOF or Ctrl-C prints `nothing was done` and focuses
  nothing; anything else is not 1-N and ends with the runnable list. Pipes,
  agents and tests keep the plain error and exit code. `a` also accepts the
  `--session <s> <pane>` form its own ambiguity lines print (follow-up to #84).
  The picker offers only worktrees that have a pane (running first, at most 20)
  and ends with a line counting the closed and hidden ones.
- A name now also means an oracle's main checkout: `neo` is `neo-oracle`, `thor`
  is `thor-oracle` (new tier `oracle name`, after an exact label and a repo's
  main worktree, before substring; exact verbs such as `kill` use it too).
- `maw herdr a <target>` on a target with no pane (a closed worktree) asks
  `Wake "<label>"? [y/N]` in a terminal (default No) and, on yes, wakes it with
  the `resume` code path (opens its space, brings back its newest transcript) and
  then brings it to the front. `-y`/`--yes` skips the question; `--dry` prints
  `would wake '<label>', then focus`; without a terminal the error is unchanged
  plus one line, `maw herdr a <target> -y`.

## 26.10.2-alpha.1101 — 2026-10-02

- `maw herdr a <target>` brings a target to the front, like `maw tmux a` (#82):
  it resolves any target the shared grammar does and focuses its pane over the
  session socket (`pane.focus`, which also raises its tab and workspace). Inside
  herdr that is all; for another session it focuses there and prints the switch
  command; outside herdr it focuses, then attaches. A running session's exact
  name still attaches that session, and a stopped session no longer shadows a
  live workspace of the same name. `--print` and `--dry` never focus anything.
- `maw herdr serve --demo`: the easy name for the read-only demo, exactly
  `--insecure-no-token` (#80). `--demo --rw` also opens writes (send, wake,
  cleanup, terminal) with no token for the same window; `--rw` without `--demo` is
  refused. Every demo prints its expiry clock time at start, and `/api/identity`
  carries `demo: {writes, expiresAt, secondsLeft}` so a dashboard can show the
  countdown. The missing-token error leads with both demo forms.

## 26.9.28-alpha.620 — 2026-09-28

First release to carry its CalVer in `plugin.json` (#77). It also covers the
`v26.9.20-alpha.*` and `v26.9.21-alpha.*` tags, which were published without
touching `plugin.json` or this file, so everything since 0.4.0 is listed here.


- `maw herdr audit`, `clean` and `sync` (#64). `audit` reports worktrees whose
  folder is gone, herdr spaces pointing at nothing, agents idle past `--idle`
  (herdr's idle status plus a resume provider's transcript age), checkouts only
  behind their upstream, and merged worktrees — and never changes anything.
  `clean` removes gone and merged worktrees; `sync` prunes gone ones, closes
  orphan spaces, fast-forwards behind checkouts and, with `--idle-agents`,
  closes the spaces of idle, resumable agents. Both are plan-only until `--go`
  or `--pick` (asks before each action, re-checking it first). A worktree with
  gitignored data is kept (rebuildable dirs excepted), as is anything with an
  agent, uncommitted work, a lock, or local-only commits. Removals go through
  herdr when a space is open, and herdr and `git worktree list` are re-read
  afterwards to prove they agree. A herdr session whose snapshot fails stops
  `clean`/`sync` from acting. Panes count by their cwd, whatever space holds
  them, so an agent in a plain space or one cd'd in from another checkout keeps
  the worktree; a bare shell keeps it too unless `--idle-shells`. An idle agent
  is judged by its own transcript (its provider, and herdr's `agent_session`
  id), and `.envrc` counts as data. Removal never uses `--force`.

- Add one shared target grammar, `src/cli/mod.target.mjs`, for every verb that
  takes a `<target>`: `self` (the calling pane), a path or `.`, a pane id, or a
  name (exact label, then a repo's main worktree, then a unique substring).
  Ambiguity lists runnable candidates and exits 1; `--dry` is accepted wherever
  a target is. `hey` and `peek` now resolve through it with unchanged output and
  exit codes, and gain `self`, paths and `--dry`. A path means the worktree
  containing it in every verb; `self` and paths never fall through to name
  matching; focus picks a pane only within one space, never across spaces or
  sessions (a pane id held in two sessions is now listed, not narrowed to the
  focused copy). New read-only `maw herdr resolve [<target>]` /
  `resolve --list` (#59).
- `maw herdr ls [running|open|resumable|cold]`: every git worktree in one of
  four states, including the ones with no open herdr space, which `ls` could
  not show before (#60). Plain `ls` gains a line counting all four; `--json`
  keeps its shape, adds `state`/`agents` to each workspace, and adds
  `worktrees`, `states` and `providers`. "Resumable" comes from resume
  providers — Claude and Codex built in, roots configurable, all switchable
  off with `MAW_HERDR_RESUME_PROVIDERS=none` — rather than from a vendor path
  in the plugin. A herdr session whose snapshot fails, or a repo git cannot
  list, is a stderr warning ending in the command to check it, and
  `incomplete` / `unreadable` in `--json` — never a silently wrong state. The
  tally line counts "checkouts", so it no longer reuses the tree footer's
  "worktrees" for a different number.
- `ls --json` larger than 64 KB is no longer cut at 65,536 bytes when piped
  under Bun.

- `maw herdr ls --path` prints each workspace's checkout beneath its row, as a
  full absolute path that pastes straight into `cd` (#56). The data was already
  in `--json` as `checkout`; only the human-facing view lacked it.
- `--help` / `-h` after any verb prints the usage instead of `unknown argument`,
  and runs nothing. A usage error with no fix line of its own now ends with
  `maw herdr <verb> --help`. A verb that does not exist is still
  `unknown command` (exit 2) with `--help` after it, so probing for a verb
  cannot get a false yes. `wake <oracle> --kind -h` is now a help request: it
  used to take `-h` as the engine, create a workspace, and fail on
  `agent start`, leaving the workspace behind.
- `maw herdr ls` groups workspaces by herdr's `repo_key` (the shared git dir)
  instead of the repo name. Two same-named checkouts from different orgs are
  now two groups, and a group prints every mother workspace, where before the
  second one was dropped from the tree without notice.
- Add `maw herdr watch <target>` / `watch --list` / `watch <target> --stop` and
  `maw herdr inbox`, the return path for `hey` (#63). A watch learns completion
  from herdr's pushed `pane.agent_status_changed` events (no polling), fires
  exactly once per busy→idle/done transition (`--every`: once per completion),
  and is held by one detached watcher process per watch with a record under
  `<config>/maw-herdr/watches/`. Watches on panes that close or whose herdr
  session stops clean themselves up with a `vanished` note; a pane that herdr
  moves (a new pane id) keeps its watch, recognised by its terminal id; orphaned
  records are swept by `watch --list` (and only there — `--dry` deletes
  nothing). `--stop` is scoped by `--session`, since pane ids repeat across
  sessions. Notes are addressed to a pane and read with `inbox`, which is
  read-only and shows this pane's notes only. `maw herdr reply <target> <text>`
  files an answer in another pane's inbox, signed with this pane's address.
- Add the lifecycle verbs `restart`, `resume`, `kill` and `close`, all on the
  shared target grammar and all honouring `--dry` (#62). `restart` reads argv
  from the running process in the pane (herdr's process-info for the pid, then
  `/proc` or `ps`), quits it with Ctrl-C until the pid is gone, and relaunches it
  in the same pane with the same herdr name, deduplicated and with the claude or
  codex session pinned to the one herdr reports; on a target with no live agent it
  fails and prints the `resume` command. `restart self` / `kill self` from inside
  the agent hand off to a detached worker logging to `~/.maw/herdr/lifecycle.log`.
  `resume` starts the agent on the worktree's newest Claude or Codex transcript,
  opening the space through `herdr worktree open --cwd <repo>` when needed. `close`
  refuses a space with a live agent unless `--force`. New modules:
  `src/cli/mod.lifecycle.mjs`, `mod.agentArgv.mjs`, and a minimal
  `mod.resumeLookup.mjs` with the #60 provider interface (to be replaced by #60's
  `mod.resumeProviders.mjs` on merge). Smoke: `utils/smoke-lifecycle.mjs`, a fake
  herdr hosting real fake-agent processes.
- Harden the lifecycle verbs after review (#62): restart drops the runtime AND the
  script of an interpreter-hosted agent, refuses a wrapped agent (omx around codex)
  and an argv with control characters before stopping anything, retries herdr's
  transient busy/name-taken answers, and ends a failed relaunch with the `resume`
  command; restart/kill/close take no substring names and never pick an agent by
  focus; resume takes a pane beside a running neighbour, skips sessions a live
  agent holds and picks a free agent name; close also refuses panes running a job;
  every printed herdr line and the worker log redact secret values; unreadable
  `process-info` is an error, not "nothing runs".

- Add one shared target grammar, `src/cli/mod.target.mjs`, for every verb that
  takes a `<target>`: `self` (the calling pane), a path or `.`, a pane id, or a
  name (exact label, then a repo's main worktree, then a unique substring).
  Ambiguity lists runnable candidates and exits 1; `--dry` is accepted wherever
  a target is. `hey` and `peek` now resolve through it with unchanged output and
  exit codes, and gain `self`, paths and `--dry`. A path means the worktree
  containing it in every verb; `self` and paths never fall through to name
  matching; focus picks a pane only within one space, never across spaces or
  sessions (a pane id held in two sessions is now listed, not narrowed to the
  focused copy). New read-only `maw herdr resolve [<target>]` /
  `resolve --list` (#59).
- `POST /api/send` restores the legacy delivery semantics (#42): a `[node:oracle]`
  sender tag from `X-Maw-From` or the server's identity (slash commands
  untagged), a read of the agent's input box that refuses someone's draft,
  a roster re-read right before submitting, refusal of blocked agents, and a
  receipt that says `delivered`, `queued` or only `accepted` according to what
  the box showed, with one Enter retry when our own text stayed in it.
  Refusals return `ok/error/target/detail/state` plus a `hint` command, and
  lifecycle records carry `error` or `lastLine`. Dim placeholder text is not a
  draft. `force` stays unsupported; empty or whitespace-only text without
  attachments stays `400`, and text that the sender tag pushes past herdr's
  64 KiB prompt limit is `413 text_too_large`. Once herdr has taken the prompt
  nothing afterwards (abort, timeout, failed Enter retry) can report it
  failed or release its idempotency key; an input box that cannot be read
  before submit refuses the send. An unreadable config layer falls back to
  `local:pane/unknown` for the tag instead of refusing.
- Fix: roster targets use the decimal window index the dashboard shows. herdr
  pane ids count in base 36, so dashboard target `:12` (pane `pC`) used to
  resolve to pane `p12` on send, capture and terminal attach.
- Add `maw herdr serve --mcp` (#61): MCP over Streamable HTTP at `/mcp` on the
  dashboard listener, hand-written JSON-RPC with no new dependency. Read tools
  (`herdr_sessions`, `herdr_agents`, `herdr_capture`, `herdr_worktrees`) call
  the same routes as their HTTP twins and follow the mode; write tools
  (`herdr_send`, `herdr_wake`) require the operator token in every mode,
  including `--insecure-no-token`. Refused under `--engine`. Every MCP error,
  including a wrong Content-Type (415) and an over-limit frame (413), stays
  inside the JSON-RPC envelope and ends with a runnable fix command. Paths are
  shell-quoted, and caller input is never echoed into one.

- Remove the Go server: the dashboard is TypeScript on Bun only. `--runtime`,
  `--build` and `MAW_HERDR_SERVE_BIN` now fail with the command to use instead,
  packages ship no `bin/maw-herdr-serve` and no `bundledArtifacts`, and CI no
  longer installs Go. The 63-file Go implementation remains in git history and
  can be restored; nothing about the HTTP/WebSocket contract changed.
- Every token-file error now ends with a copy-pasteable command, with the real
  path substituted for the `chmod` hint.

- Align serving with maw-rs `engine.serve` and checksum-pinned `bundledArtifacts`:
  source-independent native packages for Linux/macOS amd64/arm64, no implicit Go
  compilation, explicit developer `--build`, and host-managed namespaced mode.
  Direct standalone authentication remains separate from the gateway trust model.
- Verify actual `maw herdr serve` dispatch in an isolated installation. The
  command is `herdr`, not `herder`; Git-only installs may omit companion files.

- Add `maw herdr serve`: existing Bun plugin launcher with a Go-backed core
  dashboard API and live WebSocket captures. Requires a private operator token,
  loopback binding, and Herdr protocol 22. Agent prompts report acceptance, not
  delivery/completion. Full lifecycle, PTY, federation and queue parity remain
  out of scope.
- Add isolated API, WebSocket, backend and launcher regression checks; no live
  sessions are written during tests. Packaged installs include the pinned native
  companion; source development requires explicit `--build` from a complete checkout.

## 0.4.0 — 2026-09-17

- `maw herdr federation` (alias `fed`): draws the mesh — who federates with whom,
  each link's health, panes per node, and what peers report about themselves. The
  one verb that does not talk to the herdr socket, because herdr has no remote RPC
  (`herdr --remote` is launch-only); it reads a herdr-federation node over HTTP,
  which already syncs every peer's roster. `HERDR_FED_URL` retargets it, `--json`
  for machines.
- Reciprocity is drawn, not assumed: `⇄` mutual, `→` we hold them, `←` they hold
  us, `··` heard but never joined. Enforcement in that service is local-only, so
  a single undirected line would hide the asymmetry that matters.
- `⇠⇢` marks a **stale** edge. What a peer reports arrives only on a successful
  pull, and while the link is down the cache keeps answering — measured: after m5
  kicked white, white still drew `⇄ m5` and "m5 federates with white" while every
  pull returned 401.
- Fixed "17 audit entrys".

## 0.3.1 — 2026-09-17

- Fix: **agent names were never matched.** The name lives on the agent record,
  not on the pane — `snapshot.panes[]` carries neither `name` nor `agent_name`,
  while `snapshot.agents[]` carries `name`, joined by `pane_id`. Reading it off a
  pane returned `undefined` for every agent, so the name tier in target
  resolution was dead code: `herdr agent get zzz-probe` resolved while
  `maw herdr peek zzz-probe` answered "no agent". Joined by `pane_id`, 8 of 26
  agents on the reference machine turned out to be named.
- This also corrects 0.2.0's claim that "0 of 28 panes carried an `agent_name`".
  That was true, and misleading: the field does not exist on a pane at all. The
  conclusion drawn from it — that workspace labels are the handle that always
  exists — still holds, because an agent has no name until someone runs
  `herdr agent rename`.

## 0.3.0 — 2026-09-17

Root-cause fix: **the plugin mapped tmux's "session" onto herdr's "session" by
name, not by role.** In tmux a session is the thing you attach to and work in; in
herdr a session is a *server process*, and the noun that plays that role is a
*workspace*. Measured: `herdr session list` returned 8 sessions, 7 stopped and
reporting 0 panes, while the one running session held 22 workspaces across 7
repos with 13 linked worktrees.

- `maw herdr ls` now lists **workspaces**, grouped machine → repo → worktree, in
  the shape herdr's own sidebar draws — with branch and `↑↓` from local git reads
  only (one `rev-list --left-right --count`, never a fetch). A worktree's branch
  is printed only when it differs from the label, and a workspace with no
  `worktree` block still gets one from its pane's cwd. Remote machines are
  separate SSH-reached servers, so the listing is local and names them rather
  than implying the fleet is one machine.
- `maw herdr ls --sessions` keeps the old server listing and now names the
  stopped ones as what they are.
- `maw herdr wake` creates a workspace in the **running** session instead of
  spawning a server per oracle — the same confusion in the other direction, and
  the source of seven stopped socket directories under
  `~/.config/herdr/sessions/`, which were precisely the seven noise rows in the
  old `ls`. `--own-session` restores the old behaviour; without it wake refuses
  rather than silently starting a server when no session is running.

## 0.2.0 — 2026-09-17

- `maw herdr hey <target> <message>`: `maw hey` for herdr — resolves a target and
  runs `herdr agent prompt <pane> <message>`. Everything after the target is the
  message, so quotes are optional. `--dry-run` prints the herdr call and sends
  nothing.
- `maw herdr peek <target>` (alias `read`), with `--lines N` and `--json`: read
  what an agent's pane is showing.
- `maw herdr ls --agents`, with `--json`: every agent pane across every running
  session, grouped by session, with status and the focused pane marked.
- Targets resolve by pane id, agent name, workspace label, tab label, then a
  unique prefix or substring of the label. **Workspace labels are the handle that
  matters**: 0 of 28 panes on the reference machine carried an `agent_name`, so a
  name-based design would have addressed nothing. A plural match is narrowed to
  the focused pane, then the workspace's active tab; anything left is listed
  rather than guessed. `--session <name>` scopes first — a flag, never a
  `session:target` prefix, because pane ids are colon-shaped too.
- `peek` always reads `--source visible`, and that is deliberately not
  configurable: herdr's own default is `recent`, which asks for scrollback and,
  on an idle agent, is serviced by driving the pane's own mouse-scroll — the
  operator watches their real terminal scroll and snap back once per read (and a
  400-line `recent` read measured 13.8s against ~0.1s for `visible`).
- The roster comes from `herdr api snapshot`, not `agent list`: the latter
  returns one row per agent and collapses a split tab into a single entry (25
  against 28 panes on the same machine), and carries no `tab_id`/`workspace_id`
  to resolve a label with.

## 0.1.0 — 2026-09-13

- `maw herdr ls` / `maw herdr ls --json`: list herdr sessions with pane and
  agent counts, `--json` mirroring the `maw ls --json` envelope.
- `maw herdr a <session>` (alias `attach`), with `--print`: attach to a herdr
  session; targets resolve like `maw a` (exact, unique prefix, unique
  substring), ambiguity lists candidates, stopped and unknown sessions are
  refused. Usage mistakes exit 2, lookup failures exit 1, like `maw a`.
- `maw herdr wake <oracle>`: `maw wake` for herdr — one headless herdr
  session per oracle (named after the repo), a workspace in the checkout, and
  `herdr agent start` with `--engine` mapped onto herdr's agent kinds;
  `--prompt`, `--attach`, `--dry-run`; idempotent when the agent already runs.
  Targets resolve from `~/.maw/oracles.json` by name, `org/repo`, or path.
- Unknown session: the error also lists matching tmux sessions from
  `maw ls --json` as "Found nearby (tmux, not herdr)" with the `maw a` command
  to run, since the two multiplexers cannot see each other.
- Attach only queries `herdr session list`; pane/agent counts are fetched by
  `ls` alone, so one wedged session cannot stall an attach.
- Without a terminal on stdin (maw before #992), attach refuses with the exact
  `herdr` command to run instead of launching a TUI into a null stdin.
- `cli.interactive: true` in the manifest so maw can inherit stdin for the TUI
  (maw-rs #992).
- `smoke.sh`, CI-safe: skips herdr-dependent checks when the binary is absent.
