package main

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

// Resolve a canonical pane's trusted registry identity without guessing from its
// task label or filesystem layout. Only exact checkout/worktree roots qualify.
func resolveWakeIdentity(ctx context.Context, cwd, fallbackWindow string) (string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	fail := func() (string, string, error) { return "", "", errRegistryUnavailable }
	if ctx.Err() != nil || !filepath.IsAbs(cwd) {
		return fail()
	}
	cwd, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return fail()
	}
	st, err := os.Stat(cwd)
	if err != nil || !st.IsDir() {
		return fail()
	}
	entries, err := readWakeRegistryEntries()
	if err != nil {
		return fail()
	}
	for i, entry := range entries {
		entries[i], err = validateWakeRegistryEntry(entry)
		if err != nil {
			return fail()
		}
	}
	if len(entries) == 0 {
		return cwd, fallbackWindow, nil
	}
	members := map[string]bool{}
	common := ""
	// No Git probing for ordinary non-repository directories.
	if _, err := os.Lstat(filepath.Join(cwd, ".git")); err == nil {
		top, dir, err := taskGitIdentity(ctx, cwd)
		if err == nil && top == cwd {
			raw, err := worktreeGit(ctx, cwd, "worktree", "list", "--porcelain", "-z")
			if err != nil {
				return fail()
			}
			trees, err := parseWorktrees(raw)
			if err != nil {
				return fail()
			}
			for _, tree := range trees {
				if tree.prunable {
					continue
				}
				path, err := filepath.EvalSymlinks(tree.path)
				if err == nil {
					members[path] = true
				}
			}
			if members[cwd] {
				common = dir
			}
		}
	}
	matches := []wakeRegistryEntry{}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return fail()
		}
		match := entry.Path == cwd
		if !match && common != "" && members[entry.Path] {
			top, dir, err := taskGitIdentity(ctx, entry.Path)
			if err != nil || top != entry.Path || dir != common {
				return fail()
			}
			match = true
		}
		if match {
			matches = append(matches, entry)
		}
	}
	if len(matches) > 1 {
		return fail()
	}
	if len(matches) == 1 {
		return matches[0].Path, matches[0].Name, nil
	}
	return cwd, fallbackWindow, nil
}
