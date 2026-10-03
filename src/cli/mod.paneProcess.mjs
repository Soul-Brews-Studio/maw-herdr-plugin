import { herdrJson } from './mod.syncCall.mjs';

/** A pane's foreground process group and shell pid, or null when herdr says neither. */
export function paneProcess(pane, session) {
  const info = herdrJson(['pane', 'process-info', '--pane', pane], session)?.result?.process_info;
  const fg = info?.foreground_process_group_id;
  const shell = info?.shell_pid;
  return Number.isInteger(fg) || Number.isInteger(shell) ? { fg, shell } : null;
}
