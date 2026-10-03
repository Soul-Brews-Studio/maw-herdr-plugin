// maw herdr join (alias here) — bring agents' real panes into your tab (#88).
import { TargetError, shq } from './mod.target.mjs';
import { HELP } from './mod.layoutHelp.mjs';
import { layoutArgs } from './mod.layoutArgs.mjs';
import { here, resolveMovable } from './mod.layoutCaller.mjs';
import { paneInfo } from './mod.herdrCall.mjs';
import { fmtRatio } from './mod.planShares.mjs';
import { placeShares } from './mod.placeShares.mjs';

export async function cmdJoin(args, { UsageError = Error, roster } = {}) {
  const o = layoutArgs(args, 'join', UsageError);
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
