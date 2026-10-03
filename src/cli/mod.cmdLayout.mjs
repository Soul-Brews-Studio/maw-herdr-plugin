// maw herdr layout cols|rows|main — re-tile your tab through a scratch tab in the same
// workspace, where pane ids do not change (#88).
import { TargetError } from './mod.target.mjs';
import { HELP } from './mod.layoutHelp.mjs';
import { layoutArgs } from './mod.layoutArgs.mjs';
import { here } from './mod.layoutCaller.mjs';
import { herdrJson, herdrLine, tabLayout } from './mod.herdrCall.mjs';
import { fmtRatio } from './mod.planShares.mjs';
import { paneOrder } from './mod.paneOrder.mjs';
import { placeShares, shareLine } from './mod.placeShares.mjs';

export async function cmdLayout(args, { UsageError = Error } = {}) {
  const o = layoutArgs(args, 'layout', UsageError);
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
