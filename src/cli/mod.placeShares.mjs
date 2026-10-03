// Move panes into a tab around an anchor with their shares set in each move, then
// read the tab back and say who has a new id (#88). Never resizes, never reads history.
import { shq } from './mod.target.mjs';
import { fmtRatio, planShares } from './mod.planShares.mjs';
import { paneOrder } from './mod.paneOrder.mjs';
import { herdr, herdrJson, herdrLine, tabLayout } from './mod.herdrCall.mjs';

export function shareLine(lay) {
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
export async function placeShares({ anchor, tab, moving, mode, ratio, session, dry, tell, stays }) {
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

export async function afterMoves(moved, { anchor, session, tell }) {
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
