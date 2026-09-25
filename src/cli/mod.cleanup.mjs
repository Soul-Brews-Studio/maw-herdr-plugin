/**
 * `maw herdr clean` and `maw herdr sync` (#64): act on what `audit` found.
 *
 *   clean  removes finished worktrees: gone ones (folder already deleted) and
 *          merged ones (HEAD in the default branch), plus any worktree named on
 *          the command line whose commits are on a remote.
 *   sync   makes herdr's sidebar and git agree: gone worktrees pruned, spaces on
 *          missing folders closed, checkouts only behind fast-forwarded, and with
 *          --idle-agents the spaces of agents idle past --idle closed (their
 *          transcripts stay, so `resume` brings them back).
 *
 * Both are PLAN-ONLY by default. `--go` runs the plan; `--pick` asks before each
 * action and re-checks it right before running it, since a person can take
 * minutes to answer. Nothing is closed or removed without one of the two.
 *
 * Two rules, both learned the hard way in neo-oracle/tools/fleet-tui:
 *   - a worktree holding gitignored data is KEPT. `git worktree remove` deletes
 *     ignored files with the checkout and no commit can bring them back, so
 *     gitignored is not the same as worthless. (Rebuildable dirs such as
 *     node_modules are the exception — see mod.audit.mjs.)
 *   - --pick asks before anything is closed.
 *
 * Removals go through herdr whenever a herdr space is open on the worktree
 * (`herdr worktree remove --workspace`), so the sidebar and `git worktree list`
 * never disagree; a plain space sitting wholly inside it (`workspace create
 * --cwd` binds no repo) is closed first; a worktree with no space is git's
 * alone. After acting, both are read again and any disagreement — a space or a
 * pane still on the removed folder — is printed with the command that fixes it.
 */
import { existsSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './mod.lsStateView.mjs';
import { shq } from './mod.target.mjs';
import { C, IDLE, IN_USE, audit, closeCmd, keptSummary, firstLine, git, loadWorld, occupants, parseArgs, run, scopeOf, warnIncomplete, within } from './mod.audit.mjs';

const real = p => { try { return realpathSync(p); } catch { return p; } };

// --- steps: one command each, shown exactly as it runs --------------------------

const herdrStep = (s, args) => ({ file: 'herdr', args: ['--session', s.session, ...args], shown: `herdr --session ${shq(s.session)} ${args.map(shq).join(' ')}` });
const gitStep = (dir, args) => ({ git: true, dir, args, shown: `git -C ${shq(dir)} ${args.map(shq).join(' ')}` });

// the plan saw these untracked OS-litter files and nothing else; they are
// deleted by name, never by --force, which would also override git's refusal
// for a file written after the plan or a worktree with submodules
const unlinkStep = (dir, files) => ({ unlink: files.map(f => join(dir, f)), shown: `rm -f -- ${files.map(f => shq(join(dir, f))).join(' ')}` });
const closeStep = s => herdrStep(s, ['workspace', 'close', s.workspace]);

function removalSteps(f) {
  const plainFirst = (f.plainSpaces ?? []).map(closeStep);
  if (f.kind === 'gone') {
    // herdr cannot remove a checkout that is not there; close its spaces, then git
    // forgets the worktree (`worktree remove` works on a missing folder, and unlike
    // `prune` it touches this one worktree only).
    return [...plainFirst, ...f.spaces.map(closeStep), gitStep(f.repoRoot, ['worktree', 'remove', f.path])];
  }
  const junk = f.junk?.length ? [unlinkStep(f.path, f.junk)] : [];
  if (!f.spaces.length) return [...plainFirst, ...junk, gitStep(f.repoRoot, ['worktree', 'remove', f.path])];
  // one space removes the checkout through herdr; any second space (another
  // session on the same worktree) is closed first so none is left pointing at nothing
  const [last, ...others] = [...f.spaces].reverse();
  return [...plainFirst, ...others.map(closeStep), ...junk, herdrStep(last, ['worktree', 'remove', '--workspace', last.workspace])];
}

// --- plans ------------------------------------------------------------------------

const keyOf = f => (f.kind === 'orphan' || f.kind === 'idle' ? `${f.kind}:${f.session}/${f.workspace}` : `${f.kind}:${f.path}`);

function removal(f) {
  return {
    key: keyOf(f), kind: f.kind, label: f.label, path: f.path, repoRoot: f.repoRoot,
    what: f.kind === 'gone' ? `forget gone worktree ${f.label} (${f.path})` : `remove worktree ${f.label} (${f.path})`,
    why: f.detail, steps: removalSteps(f), done: f.kind === 'gone' ? 'PRUNED' : 'RM', spaces: [...(f.plainSpaces ?? []), ...f.spaces],
  };
}

const kept = (f, reasons) => ({ kind: f.kind, label: f.label, path: f.path, session: f.session ?? null, workspace: f.workspace ?? null, named: !!f.named, reasons });

function goneOrKept(f, actions, keep) {
  // closing a space ends whatever runs in it; an agent there is a person's call
  if (f.agents.length) keep.push(kept(f, f.agents.map(a => ({ code: 'orphan-agent', reason: `agent ${a.pane} (${a.agent}, ${a.status}) is in a space on it`, fix: `maw herdr peek --session ${shq(a.session)} ${a.pane}` }))));
  else if (f.locked) keep.push(kept(f, [{ code: 'locked', reason: 'git has it locked', fix: `git -C ${shq(f.repoRoot)} worktree unlock ${shq(f.path)}` }]));
  else actions.push(removal(f));
}

export function planClean(report) {
  const actions = [];
  const keep = [];
  for (const f of report.findings) {
    if (f.kind === 'gone') goneOrKept(f, actions, keep);
    else if (f.kind === 'merged') {
      if (f.keep.length) keep.push(kept(f, f.keep));
      else actions.push(removal(f));
    }
  }
  return { actions, kept: keep };
}

export async function planSync(report, world, { idleAgents = false, idleShells = false } = {}) {
  const actions = [];
  const keep = [];
  const peek = (s, p) => `maw herdr peek --session ${shq(s)} ${p}`;
  for (const f of report.findings.filter(f => f.kind === 'gone')) goneOrKept(f, actions, keep);

  for (const f of report.findings.filter(f => f.kind === 'orphan')) {
    if (f.agents.length) {
      keep.push(kept(f, f.agents.map(p => ({ code: 'orphan-agent', reason: `agent ${p} is still in it`, fix: peek(f.session, p) }))));
      continue;
    }
    const s = { session: f.session, workspace: f.workspace };
    actions.push({ key: keyOf(f), kind: 'orphan', label: f.label, path: f.path, what: `close herdr space ${f.workspace} (${f.label}) in ${f.session}`, why: f.detail, steps: [herdrStep(s, ['workspace', 'close', f.workspace])], done: 'CLOSED', spaces: [s] });
  }

  for (const f of report.findings.filter(f => f.kind === 'behind')) {
    const reasons = [];
    const modified = await uncommittedTracked(f.path);
    if (modified === null) reasons.push({ code: 'status', reason: 'git status failed in it', fix: `git -C ${shq(f.path)} status` });
    else if (modified.length) reasons.push({ code: 'uncommitted', reason: `${modified.length} modified tracked file${modified.length === 1 ? '' : 's'}: ${modified.slice(0, 3).join(' ')}`, fix: `git -C ${shq(f.path)} status` });
    // every agent working in it, whatever space holds the pane (by its cwd)
    const tree = world.trees.find(w => w.path === f.path);
    for (const p of (tree ? occupants(tree) : []).filter(p => p.agent && !IDLE.has(p.status))) reasons.push({ code: 'agent', reason: `agent ${p.pane} is ${p.status} in it`, fix: peek(p.session, p.pane) });
    if (reasons.length) { keep.push(kept(f, reasons)); continue; }
    actions.push({ key: keyOf(f), kind: 'behind', label: f.label, path: f.path, what: `fast-forward ${f.label} ${f.behind} commit${f.behind === 1 ? '' : 's'} to ${f.upstream}`, why: f.detail, steps: [gitStep(f.path, ['merge', '--ff-only', '@{u}'])], done: 'FF', spaces: [] });
  }

  // idle agents: a space is closed only when EVERY agent in it is idle past the
  // threshold with a transcript to resume — one busy agent keeps the whole space.
  const idle = report.findings.filter(f => f.kind === 'idle');
  const bySpace = new Map();
  for (const f of idle) {
    const k = `${f.session}\0${f.workspace}`;
    if (!bySpace.has(k)) bySpace.set(k, []);
    bySpace.get(k).push(f);
  }
  for (const group of bySpace.values()) {
    const f = group[0];
    if (!idleAgents) {
      keep.push(kept(f, group.map(g => ({ code: 'needs-flag', reason: `${g.agent} in ${g.pane} idle ${Math.round(g.idleMs / 3_600_000)}h — sync closes idle agents only with --idle-agents`, fix: 'maw herdr sync --idle-agents' }))));
      continue;
    }
    const space = world.targets.find(t => t.session === f.session && t.workspace === f.workspace);
    const idlePanes = new Set(group.map(g => g.pane));
    const busy = (space?.panes ?? []).filter(p => p.agent && !idlePanes.has(p.pane));
    // closing the space ends its shells too, and a shell may be running something
    const shells = idleShells ? [] : (space?.panes ?? []).filter(p => !p.agent);
    if (busy.length || shells.length) {
      keep.push(kept(f, [
        ...busy.map(p => ({ code: 'agent', reason: `agent ${p.pane} in the same space is ${p.status}${IDLE.has(p.status) ? ' but has no transcript of its own old enough to resume' : ''}`, fix: peek(f.session, p.pane) })),
        ...shells.map(p => ({ code: 'shell', reason: `shell ${p.pane} in the same space may be running something; --idle-shells closes it too`, fix: peek(f.session, p.pane) })),
      ]));
      continue;
    }
    const s = { session: f.session, workspace: f.workspace };
    actions.push({
      key: keyOf(f), kind: 'idle', label: f.label, path: f.path,
      what: `close herdr space ${f.workspace} (${f.label}) in ${f.session}, ending idle ${group.map(g => `${g.agent} ${g.pane}`).join(', ')}`,
      why: group.map(g => `${g.detail}; resume: ${g.resume.command}`).join('\n'),
      steps: [herdrStep(s, ['workspace', 'close', f.workspace])], done: 'CLOSED', spaces: [s], resume: group.map(g => g.resume.command),
    });
  }
  return { actions, kept: keep };
}

async function uncommittedTracked(path) {
  const r = await git(path, ['status', '--porcelain', '--untracked-files=no']);
  if (!r.ok) return null;
  return r.out.split('\n').filter(Boolean).map(l => l.slice(3));
}

// --- asking -------------------------------------------------------------------------

/**
 * One line from stdin, synchronously; null at end of input. Works for a
 * terminal and for a pipe (`yes n | maw herdr clean --pick`). A closed stdin
 * answers nothing, and nothing is an answer of no.
 */
function readLine() {
  const byte = Buffer.alloc(1);
  const bytes = [];
  for (;;) {
    let n;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (err) {
      if (err.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); continue; }
      return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    }
    if (n === 0) return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    if (byte[0] === 0x0a) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(byte[0]);
  }
}

function ask(action) {
  process.stderr.write(`\n  ${action.what}\n    ${action.why.split('\n').join('\n    ')}\n  runs:\n${action.steps.map(s => `    ${s.shown}`).join('\n')}\n  do it? [y/N/q] `);
  const line = readLine();
  if (line === null) { process.stderr.write('(no answer — end of input)\n'); return 'eof'; }
  const a = line.trim().toLowerCase();
  if (a === 'q' || a === 'quit') return 'quit';
  return a === 'y' || a === 'yes' ? 'yes' : 'no';
}

// --- acting -------------------------------------------------------------------------

async function runStep(step) {
  if (step.unlink) {
    for (const f of step.unlink) {
      try { unlinkSync(f); } catch (err) { if (err.code !== 'ENOENT') return { ok: false, code: -1, out: '', err: `${f}: ${err.code ?? err.message}` }; }
    }
    return { ok: true, code: 0, out: '', err: '' };
  }
  return step.git ? git(step.dir, step.args, { timeout: 120_000 }) : run(step.file, step.args, { timeout: 60_000 });
}

/**
 * The command(s) that get past a failed step — never the step itself again.
 * herdr's `worktree remove` may refuse an untrusted repo or a primary space;
 * git's refusal usually means something appeared since the plan.
 */
function fixFor(action, step) {
  const a = step.args ?? [];
  const i = a.indexOf('remove');
  if (step.file === 'herdr' && a[i - 1] === 'worktree') {
    const session = a[1];
    const ws = a[a.indexOf('--workspace') + 1];
    return [
      `${step.shown} --trust-repository`,
      `git -C ${shq(action.repoRoot)} worktree remove ${shq(action.path)} && herdr --session ${shq(session)} workspace close ${shq(ws)}`,
    ].join('\n');
  }
  if (step.file === 'herdr') return `herdr --session ${shq(a[1])} api snapshot`;
  if (step.unlink) return `ls -la ${step.unlink.map(shq).join(' ')}`;
  if (action.kind === 'behind') return `git -C ${shq(action.path)} status`;
  if (existsSync(action.path)) return `git -C ${shq(action.path)} status --ignored`;
  return `git -C ${shq(action.repoRoot)} worktree list --porcelain`;
}

async function gitLists(repoRoot, path) {
  const r = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  return r.out.split('\n').filter(l => l.startsWith('worktree ')).map(l => real(l.slice(9))).includes(real(path));
}

async function execute(action) {
  const result = (status, detail = null, fix = null) => ({ key: action.key, kind: action.kind, label: action.label, path: action.path, spaces: action.spaces, status, detail, fix });
  for (const step of action.steps) {
    const r = await runStep(step);
    if (!r.ok) return result('FAIL', `${step.shown} failed: ${firstLine(r.err) || `exit ${r.code}`}`, fixFor(action, step));
  }
  if (action.kind === 'merged' || action.kind === 'gone') {
    if (action.kind === 'merged' && existsSync(action.path)) return result('FAIL', `${action.path} still exists after removal`, `git -C ${shq(action.repoRoot)} worktree remove ${shq(action.path)}`);
    if (await gitLists(action.repoRoot, action.path)) return result('FAIL', `git still lists ${action.path}`, `git -C ${shq(action.repoRoot)} worktree remove ${shq(action.path)}`);
  }
  if (action.kind === 'behind') {
    const r = await git(action.path, ['rev-parse', '--short', 'HEAD']);
    return result(action.done, `now at ${r.out.trim()}`);
  }
  return result(action.done, action.resume ? `resume: ${action.resume.join(' ; ')}` : null);
}

const peekOf = (s, p) => `maw herdr peek --session ${shq(s)} ${p}`;

/**
 * After acting, read herdr and git again: every removed worktree must be gone
 * from both, every closed space gone from herdr. Each disagreement carries the
 * command that settles it.
 */
async function agreement(results, reload) {
  const acted = results.filter(r => ['RM', 'PRUNED', 'CLOSED'].includes(r.status));
  if (!acted.length) return [];
  const world = await reload();
  const out = [];
  for (const r of acted) {
    if (r.status === 'RM' || r.status === 'PRUNED') {
      const tree = world.trees.find(w => w.path === r.path);
      // any space still bound to it, and any space with a pane still inside it
      // (a plain space, or one bound elsewhere with a pane cd'd in)
      const inside = p => [p.foregroundCwd, p.cwd].some(d => d && (within(r.path, d) || within(r.path, real(d))));
      for (const t of world.targets.filter(t => t.state !== 'closed' && t.session && (t.path === r.path || t.panes.some(inside)))) {
        const wholly = t.path === r.path || t.panes.every(inside);
        const p = t.panes.find(inside);
        out.push(wholly
          ? { path: r.path, problem: `herdr still shows space ${t.workspace} in ${t.session} on it`, fix: closeCmd(t) }
          : { path: r.path, problem: `pane ${p.pane} in herdr space ${t.workspace} (${t.session}) still sits in it`, fix: peekOf(t.session, p.pane) });
      }
      if (tree && (tree.prunable || existsSync(r.path))) out.push({ path: r.path, problem: 'git still lists it', fix: `git -C ${shq(tree.repoRoot)} worktree remove ${shq(r.path)}` });
    } else {
      for (const s of r.spaces) {
        if (world.targets.some(t => t.session === s.session && t.workspace === s.workspace)) out.push({ path: r.path, problem: `herdr space ${s.workspace} in ${s.session} is still open`, fix: closeCmd(s) });
      }
    }
  }
  return out;
}

// --- output -------------------------------------------------------------------------

const COLOR = { RM: C.green, PRUNED: C.green, CLOSED: C.green, FF: C.green, DECLINED: C.dim, SKIP: C.yellow, FAIL: C.red };

function printPlan(verb, plan, again) {
  for (const a of plan.actions) {
    console.log(`  ${C.cyan}would${C.off}  ${a.what}`);
    for (const line of a.why.split('\n')) console.log(`         ${C.dim}${line}${C.off}`);
    for (const s of a.steps) console.log(`         ${C.dim}$ ${s.shown}${C.off}`);
  }
  // In use, or too new, is the common case on a busy machine and needs no action:
  // one line for all of those. Anything holding data or needing a person is listed.
  const quiet = plan.kept.filter(k => !k.named && k.reasons.every(r => IN_USE.has(r.code) || r.code === 'young'));
  for (const k of plan.kept.filter(k => !quiet.includes(k))) {
    console.log(`  ${C.dim}kept${C.off}   ${k.label}  ${C.dim}${k.path ?? `${k.session} ${k.workspace}`}${C.off}`);
    for (const r of k.reasons) console.log(`         ${r.reason}\n           ${r.fix}`);
  }
  if (quiet.length) console.log(`  ${C.dim}kept${C.off}   ${quiet.length} more in use or recent: ${keptSummary(quiet.map(k => k.reasons))}${C.dim} (all of them: ${again('--json')})${C.off}`);
  if (!plan.actions.length) {
    console.log(`  nothing to ${verb}${plan.kept.length ? ` (${plan.kept.length} kept)` : ''}`);
    return;
  }
  console.log('');
  console.log(`  ${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'} planned, ${plan.kept.length} kept — plan only, nothing was changed`);
  console.log(`  run them all:   ${again('--go')}`);
  console.log(`  ask for each:   ${again('--pick')}`);
}

function printResults(results, disagree) {
  for (const r of results) {
    console.log(`  ${COLOR[r.status] ?? ''}${r.status.padEnd(8)}${C.off} ${r.label}  ${C.dim}${r.path ?? ''}${C.off}${r.detail ? `\n           ${r.detail}` : ''}${r.fix ? `\n           ${r.fix.split('\n').join('\n           ')}` : ''}`);
  }
  for (const d of disagree) console.log(`  ${C.red}✗${C.off} herdr and git disagree on ${d.path}: ${d.problem}\n    ${d.fix}`);
  const n = s => results.filter(r => r.status === s).length;
  console.log(`\n  removed ${n('RM')} · pruned ${n('PRUNED')} · closed ${n('CLOSED')} · fast-forwarded ${n('FF')} · declined ${n('DECLINED')} · skipped ${n('SKIP')} · failed ${n('FAIL')}${disagree.length ? ` · ${disagree.length} disagreement${disagree.length === 1 ? '' : 's'}` : ''}`);
}

// --- the verbs ------------------------------------------------------------------------

async function cleanup(verb, argv, { UsageError = Error, registryRoot } = {}) {
  const o = parseArgs(verb, argv, UsageError);
  const plan = async () => {
    const world = await loadWorld({ registryRoot });
    const scope = scopeOf(world, o.targets, { verb, session: o.session, UsageError });
    const report = await audit(world, { idleMs: o.idleMs, minAgeDays: o.minAgeDays, scope, idleShells: o.idleShells });
    const p = verb === 'clean' ? planClean(report) : await planSync(report, world, { idleAgents: o.idleAgents, idleShells: o.idleShells });
    return { ...p, incomplete: report.incomplete };
  };
  const first = await plan();
  const mode = o.go ? 'go' : o.pick ? 'pick' : 'plan';
  const carried = [...o.targets.map(shq), o.idleAgents ? '--idle-agents' : null, o.idleShells ? '--idle-shells' : null, o.idleRaw ? `--idle ${shq(o.idleRaw)}` : null,
    verb === 'clean' && o.minAgeDays !== 3 ? `--min-age ${o.minAgeDays}` : null, o.session ? `--session ${shq(o.session)}` : null].filter(Boolean);
  const again = flag => ['maw herdr', verb, ...carried, flag].join(' ');
  warnIncomplete(first.incomplete, mode !== 'plan');

  const shown = a => ({ key: a.key, kind: a.kind, label: a.label, path: a.path, what: a.what, why: a.why, commands: a.steps.map(s => s.shown) });
  if (mode === 'plan' || !first.actions.length || first.incomplete.length) {
    if (o.json) await writeJson({ command: verb, json: true, mode, actions: first.actions.map(shown), kept: first.kept, results: [], incomplete: first.incomplete });
    else printPlan(verb, first, again);
    // acting was asked for, and a session that did not answer could hide a space
    if (mode !== 'plan' && first.incomplete.length && first.actions.length) {
      process.stderr.write(`maw herdr: ${verb} did nothing — ${first.incomplete.length} herdr session${first.incomplete.length === 1 ? '' : 's'} did not answer, and a worktree whose space lives there would look unused\n  herdr --session ${shq(first.incomplete[0].session)} api snapshot\n`);
      return 1;
    }
    return 0;
  }

  const results = [];
  let stop = null;
  for (const action of first.actions) {
    if (stop) { results.push({ key: action.key, kind: action.kind, label: action.label, path: action.path, status: 'DECLINED', detail: `not asked (${stop})`, fix: null }); continue; }
    let todo = action;
    if (mode === 'pick') {
      const answer = ask(action);
      if (answer !== 'yes') {
        stop = answer === 'quit' ? 'you quit' : answer === 'eof' ? 'no more answers on stdin' : null;
        results.push({ key: action.key, kind: action.kind, label: action.label, path: action.path, status: 'DECLINED', detail: null, fix: null });
        continue;
      }
      // the answer may have taken minutes: plan again and act only if it still holds
      const fresh = await plan();
      todo = fresh.actions.find(a => a.key === action.key);
      // the same action with different steps (a space opened on it while the
      // prompt waited) is not what was approved: nothing unshown ever runs
      const same = todo && todo.steps.map(s => s.shown).join('\n') === action.steps.map(s => s.shown).join('\n');
      if (!same || fresh.incomplete.length) {
        const why = fresh.kept.find(k => keyOf(k) === action.key || k.path === action.path)?.reasons?.[0];
        results.push({ key: action.key, kind: action.kind, label: action.label, path: action.path, status: 'SKIP',
          detail: fresh.incomplete.length ? 'a herdr session stopped answering since the plan'
            : todo ? `changed since the plan: it would now run ${todo.steps.map(s => s.shown).join(' ; ')}` : `changed since the plan${why ? `: ${why.reason}` : ''}`,
          fix: todo ? again('--pick') : why?.fix ?? again('--pick') });
        continue;
      }
    }
    results.push(await execute(todo));
  }
  const disagree = await agreement(results, () => loadWorld({ registryRoot }));
  if (o.json) await writeJson({ command: verb, json: true, mode, actions: first.actions.map(shown), kept: first.kept, results, disagree, incomplete: first.incomplete });
  else printResults(results, disagree);
  return results.some(r => r.status === 'FAIL') || disagree.length ? 1 : 0;
}

/** `maw herdr clean [<target>...] [--go|--pick]` — exit code. */
export const cmdClean = (argv, ctx) => cleanup('clean', argv, ctx);

/** `maw herdr sync [<target>...] [--idle-agents] [--go|--pick]` — exit code. */
export const cmdSync = (argv, ctx) => cleanup('sync', argv, ctx);
