/**
 * Layout verbs (#88): join, break, layout, whoami.
 *
 * They move an agent's REAL pane — its process, history and scrollback go with it,
 * nothing restarts — between the tab you are in and a space of its own, and say
 * which pane this command really runs in. Every rule below was measured on herdr
 * before it was written down (see #88):
 *
 *   - `pane move --ratio R` is the share the TARGET pane keeps, and `--split` takes
 *     only right|down. T panes share one area evenly when the k-th move
 *     (k = 1..T−1) splits the pane added before it with 1/(T−k+1): 0.333 then 0.5
 *     for three, which gave 68 | 68 | 68 on a 204-column tab.
 *   - The share goes INTO the move. A `pane resize` afterwards is one more size
 *     change, and every size change makes a Claude Code pane redraw its whole
 *     screen — a visible full-pane flicker on a long session.
 *   - A pane id is stable inside one workspace and changes across workspaces; the
 *     new one is in `move_result.pane`. A workspace left empty closes itself
 *     (`move_result.closed_workspace_id`). So a pane coming from another space is
 *     only known by its new id once it has landed, and the next split names that.
 *   - `pane layout --pane X` returns every rect and split ratio of X's tab.
 *   - Nothing here reads pane history: `pane read --source recent|recent-unwrapped`
 *     makes an agent redraw its whole screen on every read (0 ms of the agent's CPU
 *     for `visible`, 450–640 ms for 15 history reads).
 *
 *   join <target>... [--cols|--rows|--main [--ratio R]] [--tell]   (alias: here)
 *       bring each target's pane into your tab. Your pane's area is shared: evenly
 *       (--cols, the default; --rows), or --main: you keep a left column of share R
 *       (default 1/3) and the targets stack on the right. A target already in your
 *       tab stays where it is.
 *   break [<target>...] [--into <space> | --label <name>] [--tell]   (alias: back)
 *       move each target's pane into a new space labelled with its agent name (or
 *       its repo folder), or into an existing space as a new tab. No target = self.
 *   layout <cols|rows|main> [--ratio R]
 *       re-tile your tab, keeping the panes' order: every other pane leaves for a
 *       scratch tab in the SAME workspace (ids do not change there) and comes back
 *       with its share set in the move.
 *   whoami [--json]
 *       the pane this command really runs in (mod.verifyCaller.mjs): HERDR_PANE_ID is
 *       set when a pane's process starts and goes stale once the pane changes space.
 *
 * Targets use the hey/peek grammar (resolveAgent), so an agent sitting in someone
 * else's tab is still found by its agent name; a pane id names any pane, a shell
 * included. Every target is resolved before anything moves: an ambiguous or unknown
 * one stops the verb with nothing done. --dry prints the exact herdr commands.
 * --tell sends each moved agent one line with its new id; it is off by default,
 * because a prompt starts a turn and a turn costs.
 *
 * Every herdr call names the session with --session when one is known, and the
 * binary is `herdr` from PATH (see mod.target.mjs).
 */

export const HELP = {
  join: `maw herdr join <target>... [--cols|--rows|--main [--ratio R]] [--tell] [--session S] [--dry]
  (alias: here) Bring each agent's real pane into the tab you are in — no restart, its
  history stays. The share each pane gets is set inside the move, so nothing is
  resized afterwards (a resize makes an agent redraw its whole screen).
    --cols      default: you and the targets share your pane's area evenly, left to right
    --rows      the same, top to bottom
    --main      you keep a left column of share R (default 0.333); the targets stack right
    --tell      tell each moved agent its new pane id (a prompt starts a turn: off by default)
  <target> is an agent name, a workspace or tab label, a pane id, a path, or self.
  A target already in your tab is left where it is. Every target is resolved before
  anything moves; an ambiguous one lists its panes and nothing is done.
    maw herdr join digger neo            maw herdr here digger --main --ratio 0.4`,
  break: `maw herdr break [<target>...] [--into <space> | --label <name>] [--tell] [--session S] [--dry]
  (alias: back) Move each target's real pane out to a space of its own, labelled with
  its agent name (else its repo folder). No target means self.
    --into <space>   move it into that existing space (id or label) as a new tab
    --label <name>   the new space's label, for one target
    --tell           tell each moved agent its new pane id (off by default)
  A pane already alone in its own space is left there. A label another space already
  uses is refused, with the two commands that resolve it.
    maw herdr break digger               maw herdr back digger --into w7Y`,
  layout: `maw herdr layout <cols|rows|main> [--ratio R] [--session S] [--dry]
  Re-tile the tab you are in, keeping the panes' order (left to right, then top to
  bottom; rows: top to bottom first). cols and rows share evenly; main keeps YOUR pane
  as a left column of share R (default 0.333) and stacks the rest on the right.
  Every other pane leaves for a scratch tab in the same workspace (where pane ids do
  not change) and comes back with its share set in the move. Each moved pane redraws.
    maw herdr layout cols                maw herdr layout main --ratio 0.4`,
  whoami: `maw herdr whoami [--json] [--session S]
  The herdr pane this command really runs in. HERDR_PANE_ID is set when a pane's
  process starts and is not updated when the pane moves to another space — so after
  a move the environment (and 'herdr pane current', which echoes it) names the old
  id. whoami checks the process tree: the pane whose foreground process group is
  this process's or an ancestor's, or whose shell is an ancestor.`,
};
