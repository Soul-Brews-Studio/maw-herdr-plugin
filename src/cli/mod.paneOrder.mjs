/** Reading order of a tab's panes: left to right then top to bottom, or rows first. */
export function paneOrder(panes, mode = 'cols') {
  const byXY = (a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y;
  const byYX = (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  return [...panes].sort(mode === 'rows' ? byYX : byXY).map(p => p.pane_id);
}
