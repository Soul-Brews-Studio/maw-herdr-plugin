// `git worktree list --porcelain` as two lookups: path → { branch, prunable }
// (a registered path whose folder is missing is "prunable") and branch → path
// (git refuses to check one branch out in two worktrees).
export function parseWorktrees(porcelain) {
  const byPath = new Map();
  const byBranch = new Map();
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const ref = lines.find(l => l.startsWith('branch '))?.slice('branch '.length) ?? null;
    const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    byPath.set(path, { branch, prunable: lines.some(l => l.startsWith('prunable')) });
    if (branch) byBranch.set(branch, path);
  }
  return { byPath, byBranch };
}
