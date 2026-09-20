package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func taskRepo(t *testing.T) string {
	t.Helper()
	root := federationTempDir(t)
	fixtureGit(t, root, "init", "--initial-branch=main")
	fixtureGit(t, root, "config", "user.name", "Fixture")
	fixtureGit(t, root, "config", "user.email", "fixture@example.invalid")
	fixtureGit(t, root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
	return root
}
func TestTaskSlug(t *testing.T) {
	for raw, want := range map[string]string{"Issue 90": "issue-90", "feat/foo": "featfoo", "foo..": "foo", " A\t\nB ": "a-b", "éhello🙂": "hello", strings.Repeat("a", 49) + "--z": strings.Repeat("a", 49) + "-"} {
		got, e := taskSlug(raw)
		if e != nil || got != want {
			t.Fatal(raw, got, e)
		}
	}
	for _, raw := range []string{"-bad", "\x00", "...", "💥", strings.Repeat("x", 1025)} {
		if _, e := taskSlug(raw); e == nil {
			t.Fatal(raw)
		}
	}
}
func TestTaskCreateReuseDirtyAndBranchCollision(t *testing.T) {
	ctx := context.Background()
	root := taskRepo(t)
	plan, e := planTaskWorktree(ctx, root, "issue-90")
	if e != nil || !plan.create {
		t.Fatal(plan, e)
	}
	if e = createTaskWorktree(ctx, root, plan); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(plan.path, "dirty"), []byte("keep"), 0600)
	again, e := planTaskWorktree(ctx, root, "issue-90")
	if e != nil || again.create || again.path != plan.path {
		t.Fatal(again, e)
	}
	if b, e := os.ReadFile(filepath.Join(again.path, "dirty")); e != nil || string(b) != "keep" {
		t.Fatal(e)
	}
	fixtureGit(t, root, "branch", "agents/collision")
	fixtureGit(t, root, "branch", "agents/9-old")
	plan, e = planTaskWorktree(ctx, root, "collision")
	if e != nil || filepath.Base(plan.path) != "10-collision" {
		t.Fatal(plan, e)
	}
	if e = createTaskWorktree(ctx, root, plan); e != nil {
		t.Fatal(e)
	}
}
func TestTaskMatchingAmbiguityOccupiedAndSymlink(t *testing.T) {
	ctx := context.Background()
	root := taskRepo(t)
	p := filepath.Join(root, "agents", "12-match")
	fixtureGit(t, root, "worktree", "add", p, "-b", "agents/12-match")
	plan, e := planTaskWorktree(ctx, root, "match")
	if e != nil || plan.create || plan.path != p {
		t.Fatal(plan, e)
	}
	fixtureGit(t, root, "worktree", "add", filepath.Join(root, "agents", "13-match"), "-b", "agents/13-match")
	if _, e := planTaskWorktree(ctx, root, "match"); e == nil {
		t.Fatal("ambiguous accepted")
	}
	os.MkdirAll(filepath.Join(root, "agents", "occupied"), 0700)
	if _, e := planTaskWorktree(ctx, root, "occupied"); e == nil {
		t.Fatal("occupied accepted")
	}
	other := taskRepo(t)
	os.Symlink(other, filepath.Join(root, "agents", "link"))
	if _, e := planTaskWorktree(ctx, root, "link"); e == nil {
		t.Fatal("symlink accepted")
	}
}
