package main

import (
	"context"
	"path/filepath"
	"sort"
)

// Finalize only positively resolved successful wakes; fleet errors prevent hooks.
func (b *HerdrBackend) finalizeWake(ctx context.Context, pane backendTarget, state string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	cwd, err := filepath.EvalSymlinks(pane.pane.Cwd)
	if err != nil || !filepath.IsAbs(cwd) {
		return "", errRegistryUnavailable
	}
	config, err := loadMergedConfig(cwd)
	if err != nil {
		return "", err
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
	base, oracle := pane.baseRepoPath, pane.wakeOracle
	if base == "" {
		base, oracle, err = resolveWakeIdentity(ctx, cwd, window)
		if err != nil {
			return "", err
		}
	}
	roster, err := b.roster(ctx)
	if err != nil {
		return "", err
	}
	verified := false
	for _, current := range roster.targets {
		if current.session == pane.session && current.pane.ID == pane.pane.ID && current.pane.Workspace == pane.pane.Workspace && registryPaneMatches(current, cwd) {
			verified = true
			break
		}
	}
	if !verified {
		return "", errRegistryUnavailable
	}
	keys := make([]string, 0, len(roster.targets))
	for key := range roster.targets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	live := []wakeFleetLiveWindow{}
	for _, key := range keys {
		p := roster.targets[key]
		if p.session != pane.session {
			continue
		}
		name := p.workspaceLabel
		if name == "" {
			name = p.pane.Label
		}
		if name == "" {
			name = p.pane.Title
		}
		if name == "" {
			name = p.pane.ID
		}
		live = append(live, wakeFleetLiveWindow{Name: name, Cwd: p.pane.Cwd})
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := registerWakeFleet(pane.session, live, base, window); err != nil {
		return "", err
	}
	runWakeHooks(ctx, config, oracle, pane.session, window)
	return state, nil
}
