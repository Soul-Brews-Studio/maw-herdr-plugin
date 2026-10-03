// restore's arguments: [<name|path>] [--json] [--dry] [--no-resume] [--session S] [-h].
import { shq, takeDry } from './mod.target.mjs';

export function restoreArgs(args, UsageError = Error) {
  const rest = [...args];
  const o = { dry: takeDry(rest), json: false, help: false, resume: true, session: null, target: null };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-resume') o.resume = false;
    else if (a === '--session' || a.startsWith('--session=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
      if (!v || v.startsWith('-')) throw new UsageError('--session needs a session name; list them:\n  maw herdr ls --sessions');
      o.session = v;
    } else if (a.startsWith('-')) throw new UsageError(`unknown argument: ${a}\n  maw herdr restore --help`);
    else pos.push(a);
  }
  if (pos.length > 1) throw new UsageError(`restore takes one target, got ${pos.length}; one at a time:\n${pos.map(p => `  maw herdr restore ${shq(p)}`).join('\n')}`);
  if (o.json && pos.length) throw new UsageError('--json goes with the list, not with a target\n  maw herdr restore --json');
  o.target = pos[0] ?? null;
  return o;
}
