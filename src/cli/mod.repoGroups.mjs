// How `maw herdr ls` groups workspaces into repos: mother checkout first, its
// linked worktrees beneath, the shape herdr's sidebar draws.
//
// The key is the repository itself, not its name. herdr's worktree block
// carries `repo_key` (the shared git dir, e.g. /code/orgA/tools/.git), which
// every linked worktree of one repo has in common and which a same-named
// clone in another org does not. Grouping by `repo_name` alone merged two
// different `tools` checkouts into one group, and a group printed only its
// first mother, so the second workspace vanished from the listing without a
// word. An older herdr without `repo_key` falls back to `repo_root`, then to
// the name, and every mother in a group is still printed as its own head.

/** A workspace's group key; a plain shell space (no worktree block) is alone. */
export function repoKey(w) {
  return w.repoKey ?? w.repo ?? `\u0000${w.id}`;
}

/**
 * Workspaces in listing order, grouped: [{ heads, children }]. `heads` holds
 * every non-linked workspace of the repo (or the first linked one, when no
 * mother is open); `children` the rest of its linked worktrees.
 */
export function repoGroups(spaces) {
  const byKey = new Map();
  for (const w of spaces) {
    const key = repoKey(w);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(w);
  }
  return [...byKey.values()].map(items => {
    const mothers = items.filter(w => !w.linked);
    const links = items.filter(w => w.linked);
    return mothers.length ? { heads: mothers, children: links } : { heads: links.slice(0, 1), children: links.slice(1) };
  });
}
