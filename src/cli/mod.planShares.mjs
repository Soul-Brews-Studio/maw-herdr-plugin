// How each pane gets its share INSIDE the move (#88). Measured on herdr: `pane move
// --ratio R` is the share the TARGET pane keeps and --split takes only right|down, so
// T panes share an area evenly when the k-th move splits the previous one with
// 1/(T−k+1). The share goes in the move — a resize afterwards is one more size change,
// and every size change makes a Claude Code pane redraw its whole screen.

/** herdr reports ratios to three places (0.333); the same goes back in. */
export const fmtRatio = r => String(Math.round(r * 1000) / 1000);

/**
 * The moves that give `n` incoming panes their share of the anchor's area.
 * `after` is the index of the incoming pane each step splits (-1 = the anchor):
 * a pane that comes from another workspace only has its id once it has landed.
 *   cols/rows: T = n + 1 panes share evenly; step k splits with 1/(T−k+1).
 *   main:      the anchor keeps `ratio` (default 1/3) on the left; the incoming
 *              panes stack in the right column, the j-th split with 1/(n−j+1).
 */
export function planShares(n, mode = 'cols', ratio = null) {
  const steps = [];
  if (n < 1) return steps;
  if (mode === 'main') {
    steps.push({ index: 0, after: -1, split: 'right', ratio: ratio ?? 1 / 3 });
    for (let j = 1; j < n; j++) steps.push({ index: j, after: j - 1, split: 'down', ratio: 1 / (n - j + 1) });
    return steps;
  }
  const total = n + 1;
  for (let k = 1; k <= n; k++) {
    steps.push({ index: k - 1, after: k - 2, split: mode === 'rows' ? 'down' : 'right', ratio: 1 / (total - k + 1) });
  }
  return steps;
}
