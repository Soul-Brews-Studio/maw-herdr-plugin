package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

var errRegistryUnavailable = errors.New("registry unavailable")

type wakeRegistryEntry struct {
	Name string `json:"name"`
	Org  string `json:"org"`
	Repo string `json:"repo"`
	Path string `json:"local_path"`
}

func registryControl(value string) bool {
	return strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) }) >= 0
}
func readWakeRegistry(target string) (wakeRegistryEntry, error) {
	none := wakeRegistryEntry{}
	parts := strings.Split(target, "/")
	if target == "" || registryControl(target) || strings.Contains(target, " ") || strings.HasPrefix(target, "-") || strings.Contains(target, "\\") || len(parts) > 2 {
		return none, ErrTargetNotFound
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return none, ErrTargetNotFound
		}
	}

	path := os.Getenv("MAW_ORACLES_JSON")
	if path == "" {
		home, e := os.UserHomeDir()
		if e != nil {
			return none, ErrTargetNotFound
		}
		path = filepath.Join(home, ".maw", "oracles.json")
	}
	raw, e := federationRead(path, 1<<20)
	if e != nil {
		return none, errRegistryUnavailable
	}
	if raw == nil {
		return none, ErrTargetNotFound
	}
	var store struct {
		Oracles *[]wakeRegistryEntry `json:"oracles"`
	}
	if json.Unmarshal(raw, &store) != nil || store.Oracles == nil || len(*store.Oracles) > 1024 {
		return none, errRegistryUnavailable
	}
	var shape struct {
		Oracles []json.RawMessage `json:"oracles"`
	}
	if json.Unmarshal(raw, &shape) != nil {
		return none, errRegistryUnavailable
	}
	for _, item := range shape.Oracles {
		var obj map[string]json.RawMessage
		if json.Unmarshal(item, &obj) != nil || obj == nil {
			return none, errRegistryUnavailable
		}
	}
	matches := []wakeRegistryEntry{}
	for _, entry := range *store.Oracles {
		if entry.Name == target || (entry.Org != "" && entry.Repo != "" && entry.Org+"/"+entry.Repo == target) {
			matches = append(matches, entry)
		}
	}
	if len(matches) != 1 {
		return none, ErrTargetNotFound
	}
	entry := matches[0]
	if entry.Name == "" || len(entry.Name) > 1024 || registryControl(entry.Name) || strings.HasPrefix(entry.Name, "-") || !filepath.IsAbs(entry.Path) || registryControl(entry.Path) {
		return none, errRegistryUnavailable
	}
	canonical, e := filepath.EvalSymlinks(entry.Path)
	if e != nil {
		return none, errRegistryUnavailable
	}
	st, e := os.Stat(canonical)
	if e != nil || !st.IsDir() {
		return none, errRegistryUnavailable
	}
	git, e := os.Lstat(filepath.Join(canonical, ".git"))
	if e != nil || (!git.IsDir() && !git.Mode().IsRegular()) {
		return none, errRegistryUnavailable
	}
	entry.Path = canonical
	return entry, nil
}
func registryPaneMatches(p backendTarget, path string) bool {
	if !filepath.IsAbs(p.pane.Cwd) {
		return false
	}
	cwd, e := filepath.EvalSymlinks(p.pane.Cwd)
	return e == nil && cwd == path
}
func (b *HerdrBackend) resolveRegistryWake(ctx context.Context, target string) (backendTarget, error) {
	return b.resolveRegistryWakeTask(ctx, target, nil)
}
func (b *HerdrBackend) resolveRegistryWakeTask(ctx context.Context, target string, task *string) (backendTarget, error) {
	none := backendTarget{}
	entry, e := readWakeRegistry(target)
	if e != nil {
		return none, e
	}
	roster, e := b.roster(ctx)
	if e != nil {
		return none, e
	}
	session := ""
	for _, name := range roster.running {
		if name == "default" {
			session = name
			break
		}
	}
	if session == "" && len(roster.running) == 1 {
		session = roster.running[0]
	}
	if session == "" {
		return none, errRegistryUnavailable
	}
	if task != nil {
		slug, e := taskSlug(*task)
		if e != nil {
			return none, e
		}
		plan, e := planTaskWorktree(ctx, entry.Path, slug)
		if e != nil {
			return none, e
		}
		roster, e = b.roster(ctx)
		if e != nil {
			return none, e
		}
		running := false
		for _, name := range roster.running {
			if name == session {
				running = true
			}
		}
		if !running {
			return none, errRegistryUnavailable
		}
		label := entry.Name + "-" + slug
		if len(label) > 1024 {
			return none, errRegistryUnavailable
		}
		for _, p := range roster.targets {
			if p.session == session && (p.workspaceLabel == label || p.pane.Label == label || p.pane.Title == label) && !registryPaneMatches(p, plan.path) {
				return none, errRegistryUnavailable
			}
		}
		if e := createTaskWorktree(ctx, entry.Path, plan); e != nil {
			return none, e
		}
		entry.Path = plan.path
		entry.Name = label
		roster, e = b.roster(ctx)
		if e != nil {
			return none, e
		}
		running = false
		for _, name := range roster.running {
			if name == session {
				running = true
			}
		}
		if !running {
			return none, errRegistryUnavailable
		}
		for _, p := range roster.targets {
			if p.session == session && (p.workspaceLabel == label || p.pane.Label == label || p.pane.Title == label) && !registryPaneMatches(p, entry.Path) {
				return none, errRegistryUnavailable
			}
		}

	}
	matches := []backendTarget{}
	for _, pane := range roster.targets {
		if pane.session == session && registryPaneMatches(pane, entry.Path) {
			matches = append(matches, pane)
		}
	}
	if len(matches) > 1 {
		return none, errRegistryUnavailable
	}
	if len(matches) == 1 {
		matches[0].effectiveWindow = entry.Name
		return matches[0], nil
	}
	raw, e := b.run(ctx, "--session", session, "workspace", "create", "--cwd", entry.Path, "--label", entry.Name, "--no-focus")
	if e != nil {
		return none, e
	}
	raw, e = unwrapBackend(raw)
	if e != nil {
		return none, e
	}
	var response struct {
		Type      string      `json:"type"`
		Pane      backendPane `json:"root_pane"`
		Workspace *struct {
			ID string `json:"workspace_id"`
		} `json:"workspace"`
		Tab map[string]json.RawMessage `json:"tab"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Type != "workspace_created" || response.Pane.ID == "" || response.Workspace == nil || response.Workspace.ID == "" || response.Pane.Workspace != response.Workspace.ID || response.Tab == nil {
		return none, errRegistryUnavailable
	}
	fresh, e := b.roster(ctx)
	if e != nil {
		return none, e
	}
	matches = nil
	for _, pane := range fresh.targets {
		if pane.session == session && registryPaneMatches(pane, entry.Path) {
			matches = append(matches, pane)
		}
	}
	if len(matches) != 1 || matches[0].pane.ID != response.Pane.ID || matches[0].pane.Workspace != response.Workspace.ID {
		return none, errRegistryUnavailable
	}
	matches[0].effectiveWindow = entry.Name
	return matches[0], nil
}
