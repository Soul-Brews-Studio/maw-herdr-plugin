package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type wakeProcess struct {
	PID  int    `json:"pid"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}
type wakeProcessInfo struct {
	Pane       string        `json:"pane_id"`
	Shell      int           `json:"shell_pid"`
	Foreground int           `json:"foreground_process_group_id"`
	Processes  []wakeProcess `json:"foreground_processes"`
}

func (b *HerdrBackend) configuredWakeLaunch(pane backendTarget) (wakeLaunch, bool, error) {
	if !filepath.IsAbs(pane.pane.Cwd) {
		return wakeLaunch{}, false, errWakeLaunch
	}
	cwd, e := filepath.EvalSymlinks(pane.pane.Cwd)
	if e != nil {
		return wakeLaunch{}, false, errWakeLaunch
	}
	st, e := os.Stat(cwd)
	if e != nil || !st.IsDir() {
		return wakeLaunch{}, false, errWakeLaunch
	}
	config, e := loadMergedConfig(cwd)
	if e != nil {
		return wakeLaunch{}, false, e
	}
	configured := false
	for _, key := range []string{"commands", "wake", "defaultEngine", "zaiPool"} {
		if _, ok := config[key]; ok {
			configured = true
		}
	}
	if !configured {
		return wakeLaunch{}, false, nil
	}
	if !filepath.IsAbs(pane.pane.Cwd) {
		return wakeLaunch{}, true, errWakeLaunch
	}
	window := pane.effectiveWindow
	if window == "" {
		window = pane.workspaceLabel
	}
	if window == "" {
		window = pane.pane.Label
	}
	if window == "" {
		window = pane.pane.Title
	}
	if window == "" {
		window = pane.pane.ID
	}
	launch, e := renderWakeLaunch(config, window, b.wakeEngineExplicit, "codex")
	return launch, true, e
}
func (b *HerdrBackend) wakeProcesses(ctx context.Context, pane backendTarget, cwd string) (wakeProcessInfo, error) {
	none := wakeProcessInfo{}
	raw, e := b.run(ctx, "--session", pane.session, "pane", "process-info", "--pane", pane.pane.ID)
	if e != nil {
		return none, errWakeLaunch
	}
	raw, e = unwrapBackend(raw)
	if e != nil {
		return none, errWakeLaunch
	}
	var response struct {
		Type string          `json:"type"`
		Info wakeProcessInfo `json:"process_info"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Type != "pane_process_info" || response.Info.Pane != pane.pane.ID || response.Info.Shell <= 0 || response.Info.Foreground <= 0 || response.Info.Shell > 9007199254740991 || response.Info.Foreground > 9007199254740991 || len(response.Info.Processes) > 128 {
		return none, errWakeLaunch
	}
	seen := map[int]bool{}
	for _, p := range response.Info.Processes {
		if p.PID <= 0 || p.PID > 9007199254740991 || p.Name == "" || seen[p.PID] || !filepath.IsAbs(p.Cwd) {
			return none, errWakeLaunch
		}
		seen[p.PID] = true
		real, e := filepath.EvalSymlinks(p.Cwd)
		if e != nil || real != cwd {
			return none, errWakeLaunch
		}
	}
	return response.Info, nil
}
func (b *HerdrBackend) launchConfigured(ctx context.Context, pane backendTarget, launch wakeLaunch) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cwd, e := filepath.EvalSymlinks(pane.pane.Cwd)
	if e != nil || !filepath.IsAbs(cwd) {
		return "", errWakeLaunch
	}
	before, e := b.wakeProcesses(ctx, pane, cwd)
	if e != nil || before.Foreground != before.Shell || len(before.Processes) != 1 || before.Processes[0].PID != before.Shell || !wakeShellProcess(before.Processes[0].Name) {
		return "", errWakeLaunch
	}
	if ack, e := b.run(ctx, "--session", pane.session, "pane", "run", pane.pane.ID, launch.Line); e != nil || strings.TrimSpace(string(ack)) != "" {
		return "", errWakeLaunch
	}
	healthy := 0
	for {
		info, e := b.wakeProcesses(ctx, pane, cwd)
		if e != nil {
			return "", errWakeLaunch
		}
		if info.Shell != before.Shell {
			return "", errWakeLaunch
		}
		foreground := false
		for _, p := range info.Processes {
			if info.Foreground != info.Shell && p.PID != info.Shell && !wakeShellProcess(p.Name) {
				foreground = true
			}
		}
		screen, e := b.run(ctx, "--session", pane.session, "pane", "read", pane.pane.ID, "--source", "visible", "--lines", "200", "--format", "text")
		if e != nil || len(screen) > 64<<10 {
			return "", errWakeLaunch
		}
		for _, marker := range []string{"Do you trust the contents of this directory", "Do you trust the files in this folder"} {
			if strings.Contains(string(screen), marker) {
				return "", errWakeLaunch
			}
		}
		if foreground {
			healthy++
			if healthy >= 3 && ctx.Err() == nil {
				return "launched", nil
			}
		} else {
			healthy = 0
		}
		delay := 100 * time.Millisecond
		if healthy > 0 {
			delay = 200 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", errWakeLaunch
		case <-timer.C:
		}
	}
}

func wakeShellProcess(name string) bool {
	switch filepath.Base(name) {
	case "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu":
		return true
	}
	return false
}
