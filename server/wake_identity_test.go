package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWakeIdentityVerifiedWorktree(t *testing.T) {
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	root := federationTempDir(t)
	repo := filepath.Join(root, "github.com", "org", "base-oracle")
	if err := os.MkdirAll(repo, 0700); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, repo, "init", "--initial-branch=main")
	fixtureGit(t, repo, "config", "user.name", "Fixture")
	fixtureGit(t, repo, "config", "user.email", "fixture@example.invalid")
	fixtureGit(t, repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
	task := filepath.Join(repo, "agents", "task")
	fixtureGit(t, repo, "worktree", "add", task, "-b", "task")
	registry := filepath.Join(root, "registry.json")
	t.Setenv("MAW_ORACLES_JSON", registry)
	entry := wakeRegistryEntry{Name: "original-oracle", Path: repo}
	save := func(entries ...wakeRegistryEntry) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"oracles": entries})
		if err := os.WriteFile(registry, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save(entry)
	for _, cwd := range []string{repo, task} {
		base, oracle, err := resolveWakeIdentity(context.Background(), cwd, "task-window")
		if err != nil || base != repo || oracle != entry.Name {
			t.Fatal(base, oracle, err)
		}
		windows := wakeFleetCollect(nil, base, "task-window", root)
		if len(windows) != 1 || windows[0].Kind != "oracle" {
			t.Fatal(windows)
		}
	}
	fake := filepath.Join(repo, "agents", "not-a-worktree")
	os.MkdirAll(fake, 0700)
	base, oracle, err := resolveWakeIdentity(context.Background(), fake, "fallback")
	if err != nil || base != fake || oracle != "fallback" {
		t.Fatal(base, oracle, err)
	}
	save(entry, wakeRegistryEntry{Name: "alias", Path: repo})
	if _, _, err := resolveWakeIdentity(context.Background(), task, "task-window"); err == nil {
		t.Fatal("ambiguous identity accepted")
	}
	save(entry, wakeRegistryEntry{Name: "task-alias", Path: task})
	if _, _, err := resolveWakeIdentity(context.Background(), task, "task-window"); err == nil {
		t.Fatal("ambiguous root/worktree identity accepted")
	}
	for _, raw := range []string{"{broken", `{"oracles":[null]}`, `{"oracles":[{"name":"broken","local_path":"relative"}]}`} {
		os.WriteFile(registry, []byte(raw), 0600)
		if _, _, err := resolveWakeIdentity(context.Background(), task, "task-window"); err == nil {
			t.Fatal("malformed registry accepted", raw)
		}
	}
	os.Remove(registry)
	base, oracle, err = resolveWakeIdentity(context.Background(), task, "fallback")
	if err != nil || base != task || oracle != "fallback" {
		t.Fatal(base, oracle, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := resolveWakeIdentity(ctx, task, "fallback"); err == nil {
		t.Fatal("cancellation ignored")
	}
}
