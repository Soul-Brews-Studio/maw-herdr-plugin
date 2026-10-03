// Synchronous ps / herdr reads for the `self` check (#88): it runs inside the sync
// target resolver, and both calls are quick reads.
import { execFileSync } from 'node:child_process';

export const sh = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const withSession = (args, session) => (session ? ['--session', session, ...args] : args);
export const herdrJson = (args, session) => JSON.parse(sh('herdr', withSession(args, session)));
