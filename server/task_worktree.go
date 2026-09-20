package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type taskWorktreePlan struct {
	path, branch, common string
	create               bool
}

func taskSlug(raw string) (string, error) {
	if len(raw) > 1024 || strings.HasPrefix(raw, "-") || strings.ContainsRune(raw, 0) {
		return "", errWorktree
	}
	var out strings.Builder
	space := false
	for _, c := range []byte(raw) {
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f' {
			if !space {
				out.WriteByte('-')
			}
			space = true
			continue
		}
		space = false
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			out.WriteByte(c)
		}
	}
	slug := out.String()
	for strings.Contains(slug, "..") {
		slug = strings.ReplaceAll(slug, "..", ".")
	}
	slug = strings.Trim(slug, ".-")
	if len(slug) > 50 {
		slug = slug[:50]
	}
	if slug == "" {
		return "", errWorktree
	}
	return slug, nil
}
func taskGitIdentity(ctx context.Context, path string) (string, string, error) {
	raw, e := worktreeGit(ctx, path, "rev-parse", "--show-toplevel")
	if e != nil {
		return "", "", e
	}
	top, e := filepath.EvalSymlinks(strings.TrimSpace(string(raw)))
	if e != nil {
		return "", "", errWorktree
	}
	raw, e = worktreeGit(ctx, path, "rev-parse", "--git-common-dir")
	if e != nil {
		return "", "", e
	}
	common := strings.TrimSpace(string(raw))
	if !filepath.IsAbs(common) {
		common = filepath.Join(path, common)
	}
	common, e = filepath.EvalSymlinks(common)
	if e != nil {
		return "", "", errWorktree
	}
	return top, common, nil
}
func safeTaskPath(path string) error {
	if !filepath.IsAbs(path) || registryControl(path) {
		return errWorktree
	}
	if configPathSafe(path) != nil {
		return errWorktree
	}
	return nil
}
func planTaskWorktree(ctx context.Context, repo, slug string) (taskWorktreePlan, error) {
	none := taskWorktreePlan{}
	top, common, e := taskGitIdentity(ctx, repo)
	if e != nil || top != repo {
		return none, errWorktree
	}
	raw, e := worktreeGit(ctx, repo, "worktree", "list", "--porcelain", "-z")
	if e != nil {
		return none, e
	}
	all, e := parseWorktrees(raw)
	if e != nil {
		return none, e
	}
	type candidate struct {
		name string
		tree gitWorktree
	}
	candidates := []candidate{}
	for _, tree := range all {
		p := filepath.Clean(tree.path)
		name := ""
		if filepath.Dir(p) == filepath.Join(repo, "agents") {
			name = filepath.Base(p)
		} else if filepath.Dir(p) == filepath.Dir(repo) && strings.HasPrefix(filepath.Base(p), filepath.Base(repo)+".wt-") {
			name = strings.TrimPrefix(filepath.Base(p), filepath.Base(repo)+".wt-")
		}
		if name == "" {
			continue
		}
		if tree.prunable {
			continue
		}
		if safeTaskPath(p) != nil {
			return none, errWorktree
		}
		real, e := filepath.EvalSymlinks(p)
		if e != nil || real != p {
			return none, errWorktree
		}
		ctop, ccommon, e := taskGitIdentity(ctx, p)
		if e != nil || ctop != p || ccommon != common {
			return none, errWorktree
		}
		candidates = append(candidates, candidate{name, tree})
	}
	for rank := 0; rank < 3; rank++ {
		matches := []candidate{}
		for _, c := range candidates {
			name := strings.ToLower(c.name)
			match := name == slug
			if rank == 1 {
				match = strings.HasSuffix(name, "-"+slug)
			}
			if rank == 2 {
				match = strings.HasPrefix(name, slug+"-") || strings.Contains(name, "-"+slug+"-")
			}
			if match {
				matches = append(matches, c)
			}
		}
		if len(matches) > 1 {
			return none, errWorktree
		}
		if len(matches) == 1 {
			return taskWorktreePlan{path: matches[0].tree.path, branch: matches[0].tree.branch, common: common}, nil
		}
	}
	raw, e = worktreeGit(ctx, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/agents")
	if e != nil {
		return none, e
	}
	branches := map[string]bool{}
	max := 0
	number := func(name string) {
		prefix, _, ok := strings.Cut(name, "-")
		if ok {
			n, e := strconv.Atoi(prefix)
			if e == nil && n > max {
				max = n
			}
		}
	}
	for _, c := range candidates {
		number(c.name)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) > 1000 {
		return none, errWorktree
	}
	for _, line := range lines {
		if line == "" {
			continue
		}
		branches[line] = true
		number(strings.TrimPrefix(line, "agents/"))
	}
	name := slug
	if branches["agents/"+name] {
		found := false
		for i := 1; i <= 1000; i++ {
			if max > int(^uint(0)>>1)-i {
				return none, errWorktree
			}
			name = strconv.Itoa(max+i) + "-" + slug
			if !branches["agents/"+name] {
				found = true
				break
			}
		}
		if !found {
			return none, errWorktree
		}
	}
	path := filepath.Join(repo, "agents", name)
	if safeTaskPath(path) != nil {
		return none, errWorktree
	}
	if _, e := os.Lstat(path); !os.IsNotExist(e) {
		return none, errWorktree
	}
	return taskWorktreePlan{path: path, branch: "refs/heads/agents/" + name, create: true, common: common}, nil
}
func createTaskWorktree(ctx context.Context, repo string, plan taskWorktreePlan) error {
	top, common, e := taskGitIdentity(ctx, repo)
	if e != nil || top != repo || common != plan.common {
		return errWorktree
	}
	if !plan.create {
		if safeTaskPath(plan.path) != nil {
			return errWorktree
		}
		raw, e := worktreeGit(ctx, repo, "worktree", "list", "--porcelain", "-z")
		if e != nil {
			return e
		}
		trees, e := parseWorktrees(raw)
		if e != nil {
			return e
		}
		for _, tree := range trees {
			if tree.path == plan.path && tree.branch == plan.branch && !tree.prunable {
				t, c, e := taskGitIdentity(ctx, plan.path)
				if e == nil && t == plan.path && c == common {
					return nil
				}
			}
		}
		return errWorktree
	}
	if safeTaskPath(plan.path) != nil {
		return errWorktree
	}
	if _, e := os.Lstat(plan.path); !os.IsNotExist(e) {
		return errWorktree
	}
	_, e = worktreeGit(ctx, repo, "worktree", "add", plan.path, "-b", strings.TrimPrefix(plan.branch, "refs/heads/"))
	if e != nil {
		return e
	}
	raw, e := worktreeGit(ctx, repo, "worktree", "list", "--porcelain", "-z")
	if e != nil {
		return e
	}
	trees, e := parseWorktrees(raw)
	if e != nil {
		return e
	}
	_, common, e = taskGitIdentity(ctx, repo)
	if e != nil {
		return e
	}
	for _, tree := range trees {
		if tree.path == plan.path && tree.branch == plan.branch {
			top, c, e := taskGitIdentity(ctx, plan.path)
			if e == nil && top == plan.path && c == common && safeTaskPath(plan.path) == nil {
				return nil
			}
		}
	}
	return errWorktree
}
