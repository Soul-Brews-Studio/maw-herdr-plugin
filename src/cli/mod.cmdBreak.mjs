// maw herdr break (alias back) — move panes out to a space of their own (#88).
import { basename } from 'node:path';
import { TargetError, shq } from './mod.target.mjs';
import { HELP } from './mod.layoutHelp.mjs';
import { layoutArgs } from './mod.layoutArgs.mjs';
import { here, resolveMovable } from './mod.layoutCaller.mjs';
import { herdrJson, herdrLine, paneInfo, spaceList } from './mod.herdrCall.mjs';
import { afterMoves } from './mod.placeShares.mjs';

export async function cmdBreak(args, { UsageError = Error, roster } = {}) {
  const o = layoutArgs(args, 'break', UsageError);
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
