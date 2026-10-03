/**
 * Layout verbs (#88): join, break, layout, whoami.
 *
 * They move an agent's REAL pane — its process, history and scrollback go with it,
 * nothing restarts — between the tab you are in and a space of its own, and say
 * which pane this command really runs in. Every rule below was measured on herdr
 * before it was written down (see #88):
 *
 *   - `pane move --ratio R` is the share the TARGET pane keeps, and `--split` takes
 *     only right|down. T panes share one area evenly when the k-th move
 *     (k = 1..T−1) splits the pane added before it with 1/(T−k+1): 0.333 then 0.5
 *     for three, which gave 68 | 68 | 68 on a 204-column tab.
 *   - The share goes INTO the move. A `pane resize` afterwards is one more size
 *     change, and every size change makes a Claude Code pane redraw its whole
 *     screen — a visible full-pane flicker on a long session.
 *   - A pane id is stable inside one workspace and changes across workspaces; the
 *     new one is in `move_result.pane`. A workspace left empty closes itself
 *     (`move_result.closed_workspace_id`). So a pane coming from another space is
 *     only known by its new id once it has landed, and the next split names that.
 *   - `pane layout --pane X` returns every rect and split ratio of X's tab.
 *   - Nothing here reads pane history: `pane read --source recent|recent-unwrapped`
 *     makes an agent redraw its whole screen on every read (0 ms of the agent's CPU
 *     for `visible`, 450–640 ms for 15 history reads).
 *
 *   join <target>... [--cols|--rows|--main [--ratio R]] [--tell]   (alias: here)
 *       bring each target's pane into your tab. Your pane's area is shared: evenly
 *       (--cols, the default; --rows), or --main: you keep a left column of share R
 *       (default 1/3) and the targets stack on the right. A target already in your
 *       tab stays where it is.
 *   break [<target>...] [--into <space> | --label <name>] [--tell]   (alias: back)
 *       move each target's pane into a new space labelled with its agent name (or
 *       its repo folder), or into an existing space as a new tab. No target = self.
 *   layout <cols|rows|main> [--ratio R]
 *       re-tile your tab, keeping the panes' order: every other pane leaves for a
 *       scratch tab in the SAME workspace (ids do not change there) and comes back
 *       with its share set in the move.
 *   whoami [--json]
 *       the pane this command really runs in (mod.callerPane.mjs): HERDR_PANE_ID is
 *       set when a pane's process starts and goes stale once the pane changes space.
 *
 * Targets use the hey/peek grammar (resolveAgent), so an agent sitting in someone
 * else's tab is still found by its agent name; a pane id names any pane, a shell
 * included. Every target is resolved before anything moves: an ambiguous or unknown
 * one stops the verb with nothing done. --dry prints the exact herdr commands.
 * --tell sends each moved agent one line with its new id; it is off by default,
 * because a prompt starts a turn and a turn costs.
 *
 * Every herdr call names the session with --session when one is known, and the
 * binary is `herdr` from PATH (see mod.target.mjs).
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { TargetError, callerFromEnv, classifyTarget, resolveAgent, shq, takeDry } from './mod.target.mjs';
import { verifyCaller } from './mod.callerPane.mjs';

export const HELP = {
  join: `maw herdr join <target>... [--cols|--rows|--main [--ratio R]] [--tell] [--session S] [--dry]
  (alias: here) Bring each agent's real pane into the tab you are in — no restart, its
  history stays. The share each pane gets is set inside the move, so nothing is
  resized afterwards (a resize makes an agent redraw its whole screen).
    --cols      default: you and the targets share your pane's area evenly, left to right
    --rows      the same, top to bottom
    --main      you keep a left column of share R (default 0.333); the targets stack right
    --tell      tell each moved agent its new pane id (a prompt starts a turn: off by default)
  <target> is an agent name, a workspace or tab label, a pane id, a path, or self.
  A target already in your tab is left where it is. Every target is resolved before
  anything moves; an ambiguous one lists its panes and nothing is done.
    maw herdr join digger neo            maw herdr here digger --main --ratio 0.4`,
  break: `maw herdr break [<target>...] [--into <space> | --label <name>] [--tell] [--session S] [--dry]
  (alias: back) Move each target's real pane out to a space of its own, labelled with
  its agent name (else its repo folder). No target means self.
    --into <space>   move it into that existing space (id or label) as a new tab
    --label <name>   the new space's label, for one target
    --tell           tell each moved agent its new pane id (off by default)
  A pane already alone in its own space is left there. A label another space already
  uses is refused, with the two commands that resolve it.
    maw herdr break digger               maw herdr back digger --into w7Y`,
  layout: `maw herdr layout <cols|rows|main> [--ratio R] [--session S] [--dry]
  Re-tile the tab you are in, keeping the panes' order (left to right, then top to
  bottom; rows: top to bottom first). cols and rows share evenly; main keeps YOUR pane
  as a left column of share R (default 0.333) and stacks the rest on the right.
  Every other pane leaves for a scratch tab in the same workspace (where pane ids do
  not change) and comes back with its share set in the move. Each moved pane redraws.
    maw herdr layout cols                maw herdr layout main --ratio 0.4`,
  whoami: `maw herdr whoami [--json] [--session S]
  The herdr pane this command really runs in. HERDR_PANE_ID is set when a pane's
  process starts and is not updated when the pane moves to another space — so after
  a move the environment (and 'herdr pane current', which echoes it) names the old
  id. whoami checks the process tree: the pane whose foreground process group is
  this process's or an ancestor's, or whose shell is an ancestor.`,
};

// --- herdr plumbing (the shape mod.lifecycle.mjs uses) -------------------------------

function run(file, args, { timeout = 15_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.detail = String(stderr || err.message || '').trim().split('\n')[0];
        fail(err);
      } else ok(stdout);
    });
  });
}

const withSessionFlag = (args, session) => (session ? ['--session', session, ...args] : args);
const herdrLine = (args, session) => ['herdr', ...withSessionFlag(args, session)].map(shq).join(' ');

async function herdr(args, session) {
  try {
    return await run('herdr', withSessionFlag(args, session));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new TargetError('herdr is not on PATH\n  command -v herdr || echo "herdr not on PATH: $PATH"', 'not-found');
    throw new TargetError(`herdr ${args.slice(0, 2).join(' ')} failed — ${err.detail || err.message}\n  ${herdrLine(args, session)}`, 'herdr');
  }
}

async function herdrJson(args, session) {
  const text = await herdr(args, session);
  try {
    return JSON.parse(text);
  } catch {
    throw new TargetError(`herdr ${args.slice(0, 2).join(' ')} returned something that is not JSON (${JSON.stringify(String(text).trim().slice(0, 60))}) — see what it prints:\n  ${herdrLine(args, session)}`, 'herdr');
  }
}

async function paneInfo(pane, session) {
  const p = (await herdrJson(['pane', 'get', pane], session)).result?.pane;
  if (!p?.tab_id) throw new TargetError(`herdr has no pane ${pane}${session ? ` in session ${session}` : ''}\n  see every pane: maw herdr ls --agents`, 'not-found');
  return p;
}

async function spaceList(session) {
  return (await herdrJson(['workspace', 'list'], session)).result?.workspaces ?? [];
}

async function tabLayout(pane, session) {
  return (await herdrJson(['pane', 'layout', '--pane', pane], session)).result?.layout ?? null;
}

// --- pure planning ---------------------------------------------------------------------

/** herdr reports ratios to three places (0.333); the same goes back in. */
export const fmtRatio = r => String(Math.round(r * 1000) / 1000);

/**
 * The moves that give `n` incoming panes their share of the anchor's area.
 * `after` is the index of the incoming pane each step splits (-1 = the anchor):
 * a pane that comes from another workspace only has its id once it has landed.
 *   cols/rows: T = n + 1 panes share evenly; step k splits with 1/(T−k+1).
 *   main:      the anchor keeps `ratio` (default 1/3) on the left; the incoming
 *              panes stack in the right column, the j-th split with 1/(n−j+1).
 */
export function planShares(n, mode = 'cols', ratio = null) {
  const steps = [];
  if (n < 1) return steps;
  if (mode === 'main') {
    steps.push({ index: 0, after: -1, split: 'right', ratio: ratio ?? 1 / 3 });
    for (let j = 1; j < n; j++) steps.push({ index: j, after: j - 1, split: 'down', ratio: 1 / (n - j + 1) });
    return steps;
  }
  const total = n + 1;
  for (let k = 1; k <= n; k++) {
    steps.push({ index: k - 1, after: k - 2, split: mode === 'rows' ? 'down' : 'right', ratio: 1 / (total - k + 1) });
  }
  return steps;
}

/** Reading order of a tab's panes: left to right then top to bottom, or rows first. */
export function paneOrder(panes, mode = 'cols') {
  const byXY = (a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y;
  const byYX = (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  return [...panes].sort(mode === 'rows' ? byYX : byXY).map(p => p.pane_id);
}

// --- arguments -------------------------------------------------------------------------

const MODES = new Set(['cols', 'rows', 'main']);

function parse(args, verb, UsageError) {
  const rest = [...args];
  const o = { dry: takeDry(rest), session: null, help: false, mode: null, ratio: null, ratioRaw: null, tell: false, into: null, label: null, json: false, targets: [] };
  const value = (i, flag) => {
    const a = rest[i];
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[i + 1];
    if (!v || v.startsWith('-')) throw new UsageError(`${flag} needs a value\n  maw herdr ${verb} --help`);
    return { v, skip: a.includes('=') ? 0 : 1 };
  };
  const is = (a, flag) => a === flag || a.startsWith(`${flag}=`);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (is(a, '--session')) { const { v, skip } = value(i, '--session'); o.session = v; i += skip; }
    else if (verb === 'join' && ['--cols', '--rows', '--main'].includes(a)) {
      const mode = a.slice(2);
      if (o.mode && o.mode !== mode) throw new UsageError(`pick one of --cols, --rows, --main (got --${o.mode} and ${a})\n  maw herdr join --help`);
      o.mode = mode;
    } else if ((verb === 'join' || verb === 'layout') && is(a, '--ratio')) {
      const { v, skip } = value(i, '--ratio');
      o.ratioRaw = v; i += skip;
    } else if ((verb === 'join' || verb === 'break') && a === '--tell') o.tell = true;
    else if (verb === 'break' && is(a, '--into')) { const { v, skip } = value(i, '--into'); o.into = v; i += skip; }
    else if (verb === 'break' && is(a, '--label')) { const { v, skip } = value(i, '--label'); o.label = v; i += skip; }
    else if (verb === 'whoami' && a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new UsageError(`unknown argument: ${a}\n  maw herdr ${verb} --help`);
    else o.targets.push(a);
  }
  if (o.help) return o;
  if (verb === 'join') o.mode = o.mode ?? 'cols';
  if (verb === 'layout') {
    if (o.targets.length !== 1 || !MODES.has(o.targets[0])) throw new UsageError(`layout takes one of cols, rows, main${o.targets.length ? ` (got ${o.targets.join(' ')})` : ''}\n  maw herdr layout cols`);
    o.mode = o.targets.pop();
  }
  // the fix line repeats the caller's own targets: never a placeholder
  const mainCmd = verb === 'join' ? (o.targets.length ? `maw herdr join ${o.targets.map(shq).join(' ')} --main` : 'maw herdr join --help #') : 'maw herdr layout main';
  if (o.ratioRaw != null) {
    const r = Number(o.ratioRaw);
    if (!(r > 0 && r < 1)) throw new UsageError(`--ratio is the share your pane keeps, between 0 and 1 (got ${o.ratioRaw})\n  ${mainCmd} --ratio 0.333`);
    o.ratio = r;
  }
  if (o.ratio != null && o.mode !== 'main') throw new UsageError(`--ratio goes with main — the share your pane keeps; cols and rows share evenly\n  ${mainCmd} --ratio ${fmtRatio(o.ratio)}`);
  if (verb === 'whoami' && o.targets.length) throw new UsageError(`whoami takes no target (got ${o.targets.join(' ')})\n  maw herdr whoami`);
  if (verb === 'break' && o.into && o.label) throw new UsageError('--into moves into an existing space; --label names a new one — pick one\n  maw herdr break --help');
  return o;
}

// --- the caller --------------------------------------------------------------------------

function here(verb) {
  const env = callerFromEnv();
  if (!env?.pane) {
    throw new TargetError(`${verb} works on the tab you are in, and HERDR_PANE_ID is not set here — this is not a herdr pane\n  open herdr and run it inside: herdr`, 'no-self');
  }
  return verifyCaller(env);
}

async function resolveMovable(all, raw, verb, me, session) {
  const form = classifyTarget(raw);
  // a pane id names any pane, a shell included; the roster lists agents only
  if (form.form === 'pane' && !all.some(a => a.pane === form.value)) {
    const p = await paneInfo(form.value, session);
    return { pane: p.pane_id, agent: p.agent ?? null, name: null, session, cwd: p.cwd ?? null, how: 'pane id' };
  }
  // self may be a shell too
  if (form.form === 'self' && !all.some(a => a.pane === me.pane)) {
    const p = await paneInfo(me.pane, session);
    return { pane: p.pane_id, agent: p.agent ?? null, name: null, session, cwd: p.cwd ?? null, how: 'self' };
  }
  return resolveAgent(all, raw, verb, { caller: me });
}

// --- moving into a tab with shares ------------------------------------------------------

function shareLine(lay) {
  const W = lay?.area?.width || 1;
  const H = lay?.area?.height || 1;
  return paneOrder(lay?.panes ?? []).map(id => {
    const r = lay.panes.find(p => p.pane_id === id).rect;
    return `${id} ${r.width}×${r.height} (${(r.width / W).toFixed(2)}w ${(r.height / H).toFixed(2)}h)`;
  }).join(' | ');
}

const tellLine = (now, was) => `maw herdr: your pane moved to ${now} (was ${was}). HERDR_PANE_ID in your environment still names the id you started with; 'maw herdr whoami' shows the real one.`;

/**
 * Move `moving` into `tab` around `anchor` with the shares planShares gives.
 * `stays` says whether a pane keeps its id on the way (it already lives in the
 * tab's workspace), so --dry can name the split target or say it is not known yet.
 */
async function placeShares({ anchor, tab, moving, mode, ratio, session, dry, tell, stays }) {
  const steps = planShares(moving.length, mode, ratio);
  const cmdFor = (m, target, s) => ['pane', 'move', m.pane, '--tab', tab, '--target-pane', target, '--split', s.split, '--ratio', fmtRatio(s.ratio), '--no-focus'];
  if (dry) {
    for (const s of steps) {
      const m = moving[s.index];
      const prev = s.after < 0 ? null : moving[s.after];
      const target = !prev ? anchor : stays(prev) ? prev.pane : `<${prev.pane}'s id once it lands>`;
      console.log(`    run     ${herdrLine(cmdFor(m, target, s), session)}`);
    }
    return null;
  }
  const ids = new Map();
  const moved = [];
  for (const s of steps) {
    const m = moving[s.index];
    const target = s.after < 0 ? anchor : ids.get(moving[s.after].pane);
    const res = await herdrJson(cmdFor(m, target, s), session);
    const mr = res.result?.move_result ?? {};
    const now = mr.pane?.pane_id ?? m.pane;
    ids.set(m.pane, now);
    moved.push({ ...m, now });
    console.log(`  moved     ${m.raw ?? m.pane}  ${m.pane}${now !== m.pane ? ` → ${now}` : ''}  (${target} keeps ${fmtRatio(s.ratio)})${mr.closed_workspace_id ? ` · its space ${mr.closed_workspace_id} had nothing left and closed` : ''}`);
  }
  await afterMoves(moved, { anchor, session, tell });
  return moved;
}

async function afterMoves(moved, { anchor, session, tell }) {
  try {
    const lay = await tabLayout(anchor, session);
    if (lay?.panes?.length) console.log(`  layout    ${shareLine(lay)}`);
  } catch { /* the moves happened; the read-back is a courtesy */ }
  const renamed = moved.filter(m => m.agent && m.now !== m.pane);
  if (!renamed.length) return;
  if (tell) {
    for (const m of renamed) {
      await herdr(['agent', 'prompt', m.now, tellLine(m.now, m.pane)], session);
      console.log(`  told      ${m.now} its new id`);
    }
  } else {
    console.log(`  note      ${renamed.length === 1 ? 'its' : 'their'} HERDR_PANE_ID still names the old id; to tell ${renamed.length === 1 ? 'it' : 'them'}:`);
    for (const m of renamed) console.log(`  maw herdr hey ${m.now} ${shq(tellLine(m.now, m.pane))}`);
  }
}

// --- the verbs ---------------------------------------------------------------------------

export async function cmdJoin(args, { UsageError = Error, roster } = {}) {
  const o = parse(args, 'join', UsageError);
  if (o.help) return void console.log(HELP.join);
  if (!o.targets.length) throw new UsageError('join needs a target — an agent name, a workspace label or a pane id; see them:\n  maw herdr ls --agents');
  const me = here('join');
  const session = o.session ?? me.session;
  const mine = await paneInfo(me.pane, session);
  const all = await roster();
  const moving = [];
  for (const raw of o.targets) {
    const t = await resolveMovable(all, raw, 'join', me, session);
    if (session && t.session && t.session !== session) {
      throw new TargetError(`'${raw}' runs in herdr session ${t.session} and you are in ${session} — herdr moves panes only inside one server; nothing was done\n  go to it instead: maw herdr a --session ${shq(t.session)} ${t.pane}`, 'session');
    }
    if (t.pane === me.pane) { console.log(`  skip      '${raw}' is you (${me.pane})`); continue; }
    if (moving.some(m => m.pane === t.pane)) continue;
    const info = await paneInfo(t.pane, session);
    if (info.tab_id === mine.tab_id) { console.log(`  skip      '${raw}' (${t.pane}) is already in your tab`); continue; }
    moving.push({ raw, pane: t.pane, agent: t.agent ?? info.agent ?? null, workspace: info.workspace_id });
  }
  if (!moving.length) return void console.log('  nothing to move');
  const shares = o.mode === 'main' ? `you keep ${fmtRatio(o.ratio ?? 1 / 3)} on the left, ${moving.length === 1 ? 'it takes' : 'they stack in'} the rest` : `${moving.length + 1} even ${o.mode === 'rows' ? 'rows' : 'columns'}`;
  console.log(`  join      ${moving.map(m => `${m.raw} (${m.pane})`).join(', ')} → your tab ${mine.tab_id} beside ${me.pane}${me.stale ? ` (HERDR_PANE_ID ${me.stale} is stale)` : ''} · ${shares}`);
  const moved = await placeShares({ anchor: me.pane, tab: mine.tab_id, moving, mode: o.mode, ratio: o.ratio, session, dry: o.dry, tell: o.tell, stays: m => m.workspace === mine.workspace_id });
  if (o.dry) console.log('  --dry: nothing was done');
  return moved;
}

export async function cmdBreak(args, { UsageError = Error, roster } = {}) {
  const o = parse(args, 'break', UsageError);
  if (o.help) return void console.log(HELP.break);
  const me = here('break');
  const session = o.session ?? me.session;
  const targets = o.targets.length ? o.targets : ['self'];
  if (o.label && targets.length > 1) {
    throw new UsageError(`--label names ONE new space; break them one at a time:\n${targets.map(t => `  maw herdr break ${shq(t)} --label ${shq(`${o.label}-${t}`)}`).join('\n')}`);
  }
  const all = await roster();
  const spaces = await spaceList(session);
  let into = null;
  if (o.into) {
    const hits = spaces.filter(w => w.workspace_id === o.into || w.label === o.into);
    if (hits.length !== 1) {
      const list = (hits.length ? hits : spaces).map(w => `  maw herdr break ${targets.map(shq).join(' ')} --into ${w.workspace_id}   # ${w.label ?? '(no label)'}`).join('\n');
      throw new TargetError(`${hits.length ? `'${o.into}' names ${hits.length} spaces` : `no space '${o.into}'`} — nothing was done; name one by id:\n${list}`, hits.length ? 'ambiguous' : 'not-found');
    }
    into = hits[0];
  }
  const plan = [];
  const claimed = new Set();
  for (const raw of targets) {
    const t = await resolveMovable(all, raw, 'break', me, session);
    if (plan.some(p => p.pane === t.pane)) continue;
    const info = await paneInfo(t.pane, session);
    if (into) {
      if (info.workspace_id === into.workspace_id) { console.log(`  skip      '${raw}' (${t.pane}) is already in space ${into.workspace_id}`); continue; }
      plan.push({ raw, pane: t.pane, agent: t.agent ?? info.agent ?? null, to: `space ${into.workspace_id} '${into.label ?? ''}', as a new tab`, cmd: ['pane', 'move', t.pane, '--new-tab', '--workspace', into.workspace_id, '--no-focus'] });
      continue;
    }
    const own = spaces.find(w => w.workspace_id === info.workspace_id);
    if (own && own.pane_count === 1) { console.log(`  skip      '${raw}' (${t.pane}) is already alone in its own space ${own.workspace_id} '${own.label ?? ''}'`); continue; }
    const cwd = info.cwd ?? t.cwd ?? null;
    const name = o.label ?? t.name ?? (cwd ? basename(cwd) : null) ?? t.pane.replace(':', '-');
    const clash = spaces.find(w => w.label === name && w.workspace_id !== info.workspace_id);
    if (clash || claimed.has(name)) {
      const where = clash ? `already exists (${clash.workspace_id})` : 'is taken by another target in this command';
      throw new TargetError(`a space named '${name}' ${where} — nothing was done. ${clash ? 'Move it in there as a new tab, or give' : 'Give'} the new space another name:\n${clash ? `  maw herdr break ${shq(raw)} --into ${clash.workspace_id}\n` : ''}  maw herdr break ${shq(raw)} --label ${shq(`${name}-2`)}`, 'exists');
    }
    claimed.add(name);
    plan.push({ raw, pane: t.pane, agent: t.agent ?? info.agent ?? null, to: `a new space '${name}'`, cmd: ['pane', 'move', t.pane, '--new-workspace', '--label', name, '--no-focus'] });
  }
  if (!plan.length) return void console.log('  nothing to move');
  for (const p of plan) {
    console.log(`  break     ${p.raw} (${p.pane}) → ${p.to}${p.pane === me.pane ? ' — that is you' : ''}`);
    console.log(`    run     ${herdrLine(p.cmd, session)}`);
  }
  if (o.dry) return void console.log('  --dry: nothing was done');
  const moved = [];
  for (const p of plan) {
    const mr = (await herdrJson(p.cmd, session)).result?.move_result ?? {};
    const now = mr.pane?.pane_id ?? p.pane;
    moved.push({ ...p, now });
    console.log(`  moved     ${p.raw}  ${p.pane}${now !== p.pane ? ` → ${now}` : ''}${mr.closed_workspace_id ? ` · space ${mr.closed_workspace_id} had nothing left and closed` : ''}`);
  }
  // read back the caller's tab — under its new id if the caller itself moved
  const self = moved.find(m => m.pane === me.pane);
  await afterMoves(moved, { anchor: self ? self.now : me.pane, session, tell: o.tell });
  return moved;
}

export async function cmdLayout(args, { UsageError = Error } = {}) {
  const o = parse(args, 'layout', UsageError);
  if (o.help) return void console.log(HELP.layout);
  const me = here('layout');
  const session = o.session ?? me.session;
  const lay = await tabLayout(me.pane, session);
  if (!lay?.panes?.length || !lay.tab_id || !lay.workspace_id) {
    throw new TargetError(`herdr returned no layout for ${me.pane}\n  ${herdrLine(['pane', 'layout', '--pane', me.pane], session)}`, 'herdr');
  }
  const order = paneOrder(lay.panes, o.mode);
  const anchor = o.mode === 'main' ? me.pane : order[0];
  const others = order.filter(p => p !== anchor);
  if (!others.length) return void console.log('  one pane in this tab — nothing to arrange');
  console.log(`  layout    ${o.mode} in tab ${lay.tab_id}: ${[anchor, ...others].join(', ')}${o.mode === 'main' ? ` · ${anchor} keeps ${fmtRatio(o.ratio ?? 1 / 3)}` : ''}`);
  console.log(`  now       ${shareLine(lay)}`);
  // out to a scratch tab in the same workspace, where ids do not change
  const out = others.map((p, i) => (i === 0
    ? ['pane', 'move', p, '--new-tab', '--workspace', lay.workspace_id, '--no-focus']
    : ['pane', 'move', p, '--tab', '<scratch tab>', '--target-pane', others[i - 1], '--split', 'down', '--no-focus']));
  const moving = others.map(p => ({ pane: p, raw: p, agent: lay.panes.find(x => x.pane_id === p)?.agent ?? null, workspace: lay.workspace_id }));
  if (o.dry) {
    for (const cmd of out) console.log(`    run     ${herdrLine(cmd, session)}`);
    await placeShares({ anchor, tab: lay.tab_id, moving, mode: o.mode, ratio: o.ratio, session, dry: true, stays: () => true });
    return void console.log('  --dry: nothing was done');
  }
  let scratch = null;
  for (const cmd of out) {
    const real = cmd.map(a => (a === '<scratch tab>' ? scratch : a));
    const mr = (await herdrJson(real, session)).result?.move_result ?? {};
    if (!scratch) scratch = mr.pane?.tab_id;
    if (!scratch) throw new TargetError(`herdr moved ${cmd[2]} but did not say which tab it opened — stopped half way; see the tab:\n  ${herdrLine(['pane', 'layout', '--pane', me.pane], session)}`, 'herdr');
  }
  return placeShares({ anchor, tab: lay.tab_id, moving, mode: o.mode, ratio: o.ratio, session, dry: false, tell: false, stays: () => true });
}

export async function cmdWhoami(args, { UsageError = Error } = {}) {
  const o = parse(args, 'whoami', UsageError);
  if (o.help) return void console.log(HELP.whoami);
  const env = callerFromEnv();
  if (!env?.pane) throw new TargetError('HERDR_PANE_ID is not set here — this is not a herdr pane\n  open herdr and run it inside: herdr', 'no-self');
  const me = verifyCaller(env);
  const session = o.session ?? me.session;
  let info = null;
  try { info = await paneInfo(me.pane, session); } catch { /* reported below */ }
  let space = null;
  try { space = (await spaceList(session)).find(w => w.workspace_id === info?.workspace_id) ?? null; } catch { /* label is a courtesy */ }
  const result = {
    pane: me.pane, tab: info?.tab_id ?? null, workspace: info?.workspace_id ?? null, label: space?.label ?? null,
    session: session ?? null, cwd: info?.cwd ?? null, env: env.pane, stale: !!me.stale, confirmed: !!me.confirmed,
  };
  if (!info) process.exitCode = 1;
  if (o.json) return void console.log(JSON.stringify(result, null, 2));
  console.log(`  ${me.confirmed ? '●' : '○'} ${me.pane}${result.tab ? `  tab ${result.tab}` : ''}${result.workspace ? `  space ${result.workspace}${result.label ? ` '${result.label}'` : ''}` : ''}${session ? `  session ${session}` : ''}`);
  if (result.cwd) console.log(`    cwd   ${result.cwd}`);
  if (me.stale) console.log(`    env   HERDR_PANE_ID=${env.pane} is STALE — this pane moved to another space after its process started;\n          anything that trusts the env (herdr pane current) names the wrong pane here`);
  else if (me.confirmed) console.log(`    env   HERDR_PANE_ID=${env.pane} — matches`);
  else console.log(`    env   HERDR_PANE_ID=${env.pane} — not confirmed: no pane runs this process in its foreground (a detached job?), so this is the environment's word`);
  if (!info) console.log(`    note  herdr has no pane ${me.pane}${session ? ` in session ${session}` : ''}\n  see every pane: maw herdr ls --agents`);
}
