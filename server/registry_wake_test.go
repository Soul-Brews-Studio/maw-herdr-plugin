package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func registryFixture(t *testing.T) string {
	t.Helper()
	root := federationTempDir(t)
	repo := filepath.Join(root, "checkout")
	os.MkdirAll(filepath.Join(repo, ".git"), 0700)
	path := filepath.Join(root, "oracles.json")
	t.Setenv("MAW_ORACLES_JSON", path)
	raw, _ := json.Marshal(map[string]any{"oracles": []any{map[string]string{"name": "oracle", "org": "org", "repo": "repo", "local_path": repo}}})
	os.WriteFile(path, raw, 0600)
	return repo
}
func TestRegistryWakeExactResolution(t *testing.T) {
	repo := registryFixture(t)
	for _, name := range []string{"oracle", "org/repo"} {
		entry, e := readWakeRegistry(name)
		if e != nil || entry.Path != repo || entry.Name != "oracle" {
			t.Fatal(entry, e)
		}
	}
	for _, name := range []string{"Oracle", "repo", repo, "../oracle"} {
		if _, e := readWakeRegistry(name); e == nil {
			t.Fatal(name)
		}
	}
}
func TestRegistryWakeCreatesValidatesAndStarts(t *testing.T) {
	repo := registryFixture(t)
	b := NewHerdrBackend("fake")
	created := false
	calls := [][]string{}
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{}, args...))
		if reflect.DeepEqual(args, []string{"session", "list", "--json"}) {
			return []byte(`{"sessions":[{"name":"default","running":true}]}`), nil
		}
		if args[2] == "workspace" {
			created = true
			return []byte(`{"type":"workspace_created","root_pane":{"pane_id":"w1:p1","workspace_id":"w1"},"workspace":{"workspace_id":"w1"},"tab":{}}`), nil
		}
		if args[2] == "agent" {
			return []byte(`{"type":"agent_started","agent":{"pane_id":"w1:p1","agent":"codex","interactive_ready":true},"argv":[]}`), nil
		}
		panes := []any{}
		spaces := []any{}
		if created {
			spaces = append(spaces, map[string]string{"workspace_id": "w1"})
			panes = append(panes, map[string]any{"pane_id": "w1:p1", "workspace_id": "w1", "agent": "", "agent_status": "idle", "focused": true, "cwd": repo})
		}
		raw, _ := json.Marshal(map[string]any{"protocol": 22, "workspaces": spaces, "panes": panes})
		return raw, nil
	}
	state, e := b.Wake(context.Background(), "oracle")
	if e != nil || state != "ready" {
		t.Fatal(state, e, calls)
	}
	found := false
	for _, args := range calls {
		if len(args) > 3 && args[2] == "workspace" {
			found = true
			if !reflect.DeepEqual(args, []string{"--session", "default", "workspace", "create", "--cwd", repo, "--label", "oracle", "--no-focus"}) {
				t.Fatal(args)
			}
		}
	}
	if !found {
		t.Fatal(calls)
	}
}

func TestRegistryRejectsUnsafeAndAmbiguous(t *testing.T) {
	repo := registryFixture(t)
	path := os.Getenv("MAW_ORACLES_JSON")
	for _, raw := range []string{`{}`, `{"oracles":{}}`, strings.Repeat("x", (1<<20)+1)} {
		os.WriteFile(path, []byte(raw), 0600)
		if _, e := readWakeRegistry("oracle"); !errors.Is(e, errRegistryUnavailable) {
			t.Fatal(e)
		}
	}
	record := wakeRegistryEntry{Name: "oracle", Org: "org", Repo: "repo", Path: repo}
	raw, _ := json.Marshal(map[string]any{"oracles": []wakeRegistryEntry{record, record}})
	os.WriteFile(path, raw, 0600)
	if _, e := readWakeRegistry("oracle"); !errors.Is(e, ErrTargetNotFound) {
		t.Fatal(e)
	}
	os.Remove(path)
	os.Symlink(filepath.Join(repo, "missing"), path)
	if _, e := readWakeRegistry("oracle"); !errors.Is(e, errRegistryUnavailable) {
		t.Fatal(e)
	}
}
func TestRegistryWakeRefusesAmbiguousSessionsWithoutMutation(t *testing.T) {
	registryFixture(t)
	b := NewHerdrBackend("fake")
	mutations := 0
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "session" {
			return []byte(`{"sessions":[{"name":"one","running":true},{"name":"two","running":true}]}`), nil
		}
		if args[2] == "api" {
			return []byte(`{"protocol":22,"panes":[],"workspaces":[]}`), nil
		}
		mutations++
		return nil, errors.New("unexpected mutation")
	}
	if _, e := b.Wake(context.Background(), "oracle"); !errors.Is(e, errRegistryUnavailable) || mutations != 0 {
		t.Fatal(e, mutations)
	}
}
