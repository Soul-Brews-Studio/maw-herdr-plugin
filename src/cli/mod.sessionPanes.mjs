import { herdrJson } from './mod.syncCall.mjs';

/** Every pane id in the session — from `api snapshot`, the read the smokes already allow. */
export function sessionPanes(session) {
  const raw = herdrJson(['api', 'snapshot'], session);
  const snap = raw?.result?.snapshot ?? raw?.result ?? raw;
  return (snap?.panes ?? []).map(p => p.pane_id).filter(Boolean);
}
