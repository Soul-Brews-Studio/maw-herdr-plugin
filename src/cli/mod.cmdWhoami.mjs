// maw herdr whoami — the pane this really runs in; HERDR_PANE_ID is set once, when the
// pane's process starts, and goes stale when the pane moves to another space (#88).
import { TargetError, callerFromEnv } from './mod.target.mjs';
import { HELP } from './mod.layoutHelp.mjs';
import { layoutArgs } from './mod.layoutArgs.mjs';
import { verifyCaller } from './mod.verifyCaller.mjs';
import { paneInfo, spaceList } from './mod.herdrCall.mjs';

export async function cmdWhoami(args, { UsageError = Error } = {}) {
  const o = layoutArgs(args, 'whoami', UsageError);
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
