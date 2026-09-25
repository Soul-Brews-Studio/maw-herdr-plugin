// `maw herdr ls --path`: each workspace's checkout on its own line, beneath its
// row, as a full absolute path.
//
// Own line rather than a trailing column: checkouts run 60-90 characters, and a
// column that long wraps every row of the tree on a normal terminal. Full path
// rather than one abbreviated against the ghq root or the mother checkout
// (`·/wt/<name>`): the question this flag answers is "where on disk is it", and
// the answer has to paste straight into `cd` or `git -C`. No `~` either — it
// does not expand inside quotes.

const HEAD = ' '.repeat(6);   // under a repo row's label
const LAST = ' '.repeat(11);  // under the last worktree's label

/**
 * One path line. `place` is where the row sits in the tree: 'head' (a repo
 * group's first row), 'child' (a worktree with siblings still to come, so the
 * tree's vertical rule continues through the line), or 'last'.
 */
export function checkoutLine(checkout, place, C) {
  const indent = place === 'head' ? HEAD : place === 'child' ? `      ${C.dim}│${C.off}    ` : LAST;
  return `${indent}${checkout ?? `${C.dim}(no checkout path)${C.off}`}`;
}
