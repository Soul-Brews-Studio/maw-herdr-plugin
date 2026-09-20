package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfiguredLaunchProcessGate(t *testing.T) {
	for _, mode := range []string{"success", "ack-only", "wrong-cwd", "malformed", "busy", "late-trust", "bad-ack", "child-shell", "empty-name", "duplicate-pid"} {
		t.Run(mode, func(t *testing.T) {
			cwd := federationTempDir(t)
			pane := backendTarget{session: "fixture", pane: backendPane{ID: "w1:p1", Cwd: cwd}}
			b := NewHerdrBackend("fixture")
			submitted := false
			captures := 0
			b.run = func(ctx context.Context, args ...string) ([]byte, error) {
				switch args[3] {
				case "process-info":
					if mode == "malformed" {
						return []byte(`{}`), nil
					}
					pid := 10
					name := "sh"
					if submitted && mode != "ack-only" || mode == "busy" {
						pid = 20
						name = "codex"
						if mode == "child-shell" {
							name = "sh"
						}
						if mode == "empty-name" {
							name = ""
						}
					}
					path := cwd
					if mode == "wrong-cwd" {
						path = filepath.Dir(cwd)
					}
					processes := []any{map[string]any{"pid": pid, "name": name, "cwd": path}}
					if submitted && mode == "duplicate-pid" {
						processes = append(processes, processes[0])
					}
					raw, _ := json.Marshal(map[string]any{"type": "pane_process_info", "process_info": map[string]any{"pane_id": "w1:p1", "shell_pid": 10, "foreground_process_group_id": pid, "foreground_processes": processes}})
					return raw, nil
				case "run":
					submitted = true
					if mode == "bad-ack" {
						return []byte(`{"error":"private"}`), nil
					}
					return nil, nil
				case "read":
					captures++
					if mode == "late-trust" && captures == 2 {
						return []byte("Do you trust the files in this folder"), nil
					}
					return []byte("fixture prompt"), nil
				}
				t.Fatalf("unexpected argv %q", args)
				return nil, nil
			}
			ctx := context.Background()
			if mode == "ack-only" || mode == "child-shell" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 40*time.Millisecond)
				defer cancel()
			}
			state, e := b.launchConfigured(ctx, pane, wakeLaunch{Line: "TOKEN=private codex"})
			if mode == "success" {
				if e != nil || state != "launched" || captures != 3 {
					t.Fatal(state, e, captures)
				}
			} else {
				if e == nil || state != "" {
					t.Fatal("false launch", state, e)
				}
				if strings.Contains(e.Error(), "private") {
					t.Fatal("secret leaked")
				}
				if mode == "busy" || mode == "wrong-cwd" || mode == "malformed" {
					if submitted {
						t.Fatal("unsafe submission")
					}
				}
			}
		})
	}
}
func TestConfiguredLaunchFinalCwdAndExplicitEngine(t *testing.T) {
	cwd := federationTempDir(t)
	dir := federationTempDir(t)
	t.Setenv("MAW_CONFIG_DIR", dir)
	path := filepath.Join(cwd, ".maw", "maw.config.50.json")
	writeConfigFixture(t, path, `{"commands":{"registered":"TOKEN=private codex --model fixture","codex":"codex --explicit"}}`)
	b := NewHerdrBackend("fixture")
	pane := backendTarget{effectiveWindow: "registered", workspaceLabel: "not-used", pane: backendPane{Cwd: cwd, ID: "w1:p1"}}
	launch, configured, e := b.configuredWakeLaunch(pane)
	if e != nil || !configured || launch.SelectedKey != "registered" || !strings.Contains(launch.Line, "--model fixture") {
		t.Fatal(launch, configured, e)
	}
	explicit := "codex"
	b.wakeEngineExplicit = &explicit
	launch, _, e = b.configuredWakeLaunch(pane)
	if e != nil || launch.SelectedKey != "codex" {
		t.Fatal(launch, e)
	}
	os.Remove(path)
	_, configured, e = b.configuredWakeLaunch(pane)
	if e != nil || configured {
		t.Fatal(configured, e)
	}
}
