/**
 * `maw herdr ticket` — /herdr-ticket's script as a maw verb: one GitHub issue → one worktree named from it → an
 * agent working it (a stateful claude by default, `--oneshot` for one `claude -p` turn).
 *
 * The oracle apps (Issues → Pick up, Work → open) and the /herdr-ticket skill used to run
 * ~/.claude/skills/herdr-ticket/ticket.sh, a copy that lived outside any repo and drifted from the published one.
 * The script now ships with this plugin (scripts/herdr-ticket/), versioned and released with it, and everyone calls
 *
 *   maw herdr ticket pick <issue> [--oneshot] [--repo <path>] [--session <s>] [--json] …
 *   maw herdr ticket open <issue|worktree> [--repo <path>] [--session <s>] [--json]
 *   maw herdr ticket continue <issue|worktree> <message…>
 *   maw herdr ticket status <issue|worktree>
 *
 * Arguments pass through untouched, so `--json` keeps the script's contract: one JSON object on stdout,
 * {"ok":true,…} or {"ok":false,"error":…,"fix":[…]} with exit 1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TICKET_SH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'herdr-ticket', 'ticket.sh');

export function cmdTicket(args) {
  if (!existsSync(TICKET_SH)) {
    console.error(`✗ ticket.sh is missing from this plugin install\n  ls ${dirname(TICKET_SH)}`);
    return 1;
  }
  const r = spawnSync('bash', [TICKET_SH, ...args], { stdio: 'inherit', env: { ...process.env, TICKET_ME: 'maw herdr ticket' } });
  if (r.error) {
    console.error(`✗ could not run ticket.sh: ${r.error.message}\n  bash ${TICKET_SH} --help`);
    return 1;
  }
  return r.status ?? 1;
}
