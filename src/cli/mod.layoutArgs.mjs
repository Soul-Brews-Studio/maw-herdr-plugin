// Arguments of join / break / layout / whoami (#88). Fix lines repeat the caller's own
// targets — never a placeholder.
import { shq, takeDry } from './mod.target.mjs';
import { fmtRatio } from './mod.planShares.mjs';

const MODES = new Set(['cols', 'rows', 'main']);

export function layoutArgs(args, verb, UsageError) {
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
