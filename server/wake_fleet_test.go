package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fleetTestHome(t *testing.T) string {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"MAW_HOME", "MAW_STATE_DIR", "MAW_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "MAW_XDG"} {
		old, ok := os.LookupEnv(k)
		os.Unsetenv(k)
		t.Cleanup(func() {
			if ok {
				os.Setenv(k, old)
			} else {
				os.Unsetenv(k)
			}
		})
	}
	t.Setenv("HOME", home)
	t.Setenv("GHQ_ROOT", filepath.Join(home, "Code"))
	return home
}
func TestWakeFleetMerge(t *testing.T) {
	old := []any{map[string]any{"name": "old", "repo": "github.com/o/r", "kind": " oracle ", "extra": true}}
	got := wakeFleetMerge(old, []wakeFleetWindow{{"new", "o/r", "project"}}, "/tmp/root")
	if len(got) != 1 || got[0].Name != "new" || got[0].Kind != "project" {
		t.Fatal(got)
	}
	got = wakeFleetMerge(old, []wakeFleetWindow{{"old", "o/x", ""}}, "/tmp/root")
	if got[0].Kind != "oracle" || got[0].Repo != "o/x" {
		t.Fatal(got)
	}
	got = wakeFleetMerge(old, []wakeFleetWindow{{"a", "o/r", ""}, {"b", "o/r", ""}}, "/tmp/root")
	if len(got) != 3 {
		t.Fatal(got)
	}
}
func TestWakeFleetRegistration(t *testing.T) {
	home := fleetTestHome(t)
	base := filepath.Join(home, "Code/github.com/o/neo-oracle")
	if e := os.MkdirAll(base, 0700); e != nil {
		t.Fatal(e)
	}
	dir := filepath.Join(home, ".maw/fleet")
	os.MkdirAll(dir, 0700)
	target := filepath.Join(dir, "old.json")
	os.WriteFile(target, []byte(`{"name":"01-neo","created_at":null,"custom":{"x":1},"windows":[{"name":"prior","repo":"o/neo-oracle","kind":"project","extra":true}]}`), 0600)
	if e := registerWakeFleet("02-neo", []wakeFleetLiveWindow{{"neo-task", filepath.Join(base, "agents/task")}}, base, "neo-task"); e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(target)
	var obj map[string]any
	json.Unmarshal(data, &obj)
	if obj["name"] != "02-neo" || obj["created_at"] != nil || obj["custom"] == nil {
		t.Fatal(string(data))
	}
	windows := obj["windows"].([]any)
	if len(windows) != 1 {
		t.Fatal(string(data))
	}
	w := windows[0].(map[string]any)
	if w["repo"] != "o/neo-oracle" || w["kind"] != "oracle" || w["name"] != "neo-task" || w["extra"] != nil {
		t.Fatal(w)
	}
	os.WriteFile(target, []byte("broken"), 0600)
	if registerWakeFleet("02-neo", nil, base, "neo") == nil {
		t.Fatal("accepted malformed")
	}
	data, _ = os.ReadFile(target)
	if string(data) != "broken" {
		t.Fatal("mutated malformed")
	}
}
func TestWakeFleetPrecedenceAndSafety(t *testing.T) {
	home := fleetTestHome(t)
	base := filepath.Join(home, "Code/github.com/o/r")
	os.MkdirAll(base, 0700)
	state := filepath.Join(home, "state")
	t.Setenv("MAW_STATE_DIR", state)
	for _, dir := range []string{filepath.Join(state, "fleet"), filepath.Join(home, ".maw/fleet")} {
		os.MkdirAll(dir, 0700)
		os.WriteFile(filepath.Join(dir, "x.json"), []byte(`{"name":"s","windows":[],"retain":true}`), 0600)
	}
	if e := registerWakeFleet("s", nil, base, "w"); e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(filepath.Join(state, "fleet/x.json"))
	var obj map[string]any
	json.Unmarshal(data, &obj)
	if obj["created_by"] != "maw wake" {
		t.Fatal(string(data))
	}
	legacy, _ := os.ReadFile(filepath.Join(home, ".maw/fleet/x.json"))
	if string(legacy) != `{"name":"s","windows":[],"retain":true}` {
		t.Fatal("wrong directory changed")
	}
	os.Symlink(filepath.Join(state, "fleet/x.json"), filepath.Join(state, "fleet/link.json"))
	if registerWakeFleet("s", nil, base, "w") == nil {
		t.Fatal("symlink accepted")
	}
}
func TestWakeFleetUnknownPathNoWrite(t *testing.T) {
	home := fleetTestHome(t)
	if e := registerWakeFleet("s", nil, home, "w"); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(home, ".maw")); !os.IsNotExist(e) {
		t.Fatal("unknown slug wrote")
	}
}
