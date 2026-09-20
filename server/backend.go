package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ErrTargetNotFound = errors.New("unknown or stale target")
var ErrNotAgent = errors.New("target is not an agent pane")

// HerdrBackend never invokes a shell. Each operation resolves the current roster.
type HerdrBackend struct {
	wakeSlots          chan struct{}
	registryWakeGate   chan struct{}
	wakeEngine         string
	wakeEngineExplicit *string
	binary             string
	run                func(context.Context, ...string) ([]byte, error)
}

func NewHerdrBackend(binary string) *HerdrBackend {
	if binary == "" {
		binary = "herdr"
	}
	b := &HerdrBackend{binary: binary, wakeSlots: make(chan struct{}, 8), registryWakeGate: make(chan struct{}, 1)}
	b.run = b.command
	return b
}

type limitedOutput struct {
	bytes.Buffer
	limit int
}

// Override bytes.Buffer.ReadFrom: os/exec uses io.Copy, whose fast path
// otherwise bypasses Write and its output limit.
func (b *limitedOutput) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{b}, r)
}

func (b *limitedOutput) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, errors.New("herdr output exceeds limit")
	}
	return b.Buffer.Write(p)
}
func (b *HerdrBackend) command(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, b.binary, args...)
	cmd.WaitDelay = time.Second
	out := &limitedOutput{limit: 4 << 20}
	stderr := &limitedOutput{limit: 64 << 10}
	cmd.Stdout, cmd.Stderr = out, stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("herdr: %w", ctx.Err())
		}
		// Do not surface stderr: it may contain prompts or private terminal data.
		return nil, fmt.Errorf("herdr command failed: %w", err)
	}
	return out.Bytes(), nil
}

type backendPane struct {
	ID        string `json:"pane_id"`
	Workspace string `json:"workspace_id"`
	Agent     string `json:"agent"`
	Label     string `json:"label"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	Focused   *bool  `json:"focused"`
	Status    string `json:"agent_status"`
}
type backendTarget struct {
	effectiveWindow string
	workspaceLabel  string
	session         string
	pane            backendPane
}
type backendRoster struct {
	running  []string
	sessions []Session
	targets  map[string]backendTarget
}

// unwrap accepts the documented CLI snapshot envelopes, never an error envelope.
func unwrapBackend(raw []byte) (json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, errors.New("invalid herdr JSON object")
	}
	for _, key := range []string{"error"} {
		if v, ok := obj[key]; ok && string(v) != "null" {
			return nil, errors.New("herdr returned an error")
		}
	}
	if result, ok := obj["result"]; ok {
		return unwrapBackend(result)
	}
	if snapshot, ok := obj["snapshot"]; ok {
		return unwrapBackend(snapshot)
	}
	return raw, nil
}
func (b *HerdrBackend) roster(ctx context.Context) (backendRoster, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := backendRoster{sessions: []Session{}, targets: map[string]backendTarget{}}
	raw, err := b.run(ctx, "session", "list", "--json")
	if err != nil {
		return result, err
	}
	raw, err = unwrapBackend(raw)
	if err != nil {
		return result, err
	}
	var list struct {
		Sessions *[]struct {
			Name    string `json:"name"`
			Running *bool  `json:"running"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(raw, &list); err != nil || list.Sessions == nil {
		return result, errors.New("invalid herdr session list")
	}
	seenSessions := map[string]bool{}
	for _, server := range *list.Sessions {
		if server.Name == "" || server.Running == nil || seenSessions[server.Name] {
			return result, errors.New("invalid or duplicate herdr session")
		}
		seenSessions[server.Name] = true
		if !*server.Running {
			continue
		}
		result.running = append(result.running, server.Name)
		raw, err = b.run(ctx, "--session", server.Name, "api", "snapshot")
		if err != nil {
			return result, err
		}
		raw, err = unwrapBackend(raw)
		if err != nil {
			return result, err
		}
		var snap struct {
			Protocol   int `json:"protocol"`
			Workspaces *[]struct {
				ID    string `json:"workspace_id"`
				Label string `json:"label"`
			} `json:"workspaces"`
			Panes *[]backendPane `json:"panes"`
		}
		if err = json.Unmarshal(raw, &snap); err != nil || snap.Protocol != 22 || snap.Workspaces == nil || snap.Panes == nil {
			return result, errors.New("invalid herdr protocol-22 snapshot")
		}
		spaces := map[string]*Session{}
		labels := map[string]string{}
		for _, space := range *snap.Workspaces {
			if space.ID == "" || spaces[space.ID] != nil {
				return result, errors.New("invalid or duplicate workspace")
			}
			name := base64.RawURLEncoding.EncodeToString([]byte(server.Name)) + "/" + base64.RawURLEncoding.EncodeToString([]byte(space.ID))
			labels[space.ID] = space.Label
			spaces[space.ID] = &Session{Name: name, Source: "local", Windows: []Window{}}
		}
		seenPanes := map[string]bool{}
		for _, pane := range *snap.Panes {
			switch pane.Status {
			case "idle", "working", "blocked", "done", "unknown":
			default:
				return result, errors.New("invalid pane agent status")
			}
			space := spaces[pane.Workspace]
			prefix := pane.Workspace + ":p"
			number := strings.TrimPrefix(pane.ID, prefix)
			n, e := strconv.Atoi(number)
			if space == nil || pane.Focused == nil || pane.Status == "" || !strings.HasPrefix(pane.ID, prefix) || e != nil || n < 0 || int64(n) > 9007199254740991 || strconv.Itoa(n) != number || seenPanes[pane.ID] {
				return result, errors.New("invalid or ambiguous pane identity")
			}
			seenPanes[pane.ID] = true
			target := space.Name + ":" + number
			if _, exists := result.targets[target]; exists {
				return result, errors.New("duplicate pane target")
			}
			name := pane.Label
			if name == "" {
				name = pane.Title
			}
			if name == "" {
				name = pane.Agent
			}
			if name == "" {
				name = pane.ID
			}
			space.Windows = append(space.Windows, Window{Index: n, Name: name, Active: *pane.Focused, Cwd: pane.Cwd, Status: pane.Status, Agent: strings.TrimSpace(pane.Agent)})
			result.targets[target] = backendTarget{session: server.Name, pane: pane, workspaceLabel: labels[pane.Workspace]}
		}
		for _, space := range spaces {
			sort.Slice(space.Windows, func(i, j int) bool { return space.Windows[i].Index < space.Windows[j].Index })
			result.sessions = append(result.sessions, *space)
		}
	}
	sort.Slice(result.sessions, func(i, j int) bool { return result.sessions[i].Name < result.sessions[j].Name })
	return result, nil
}
func (b *HerdrBackend) Sessions(ctx context.Context) ([]Session, error) {
	roster, err := b.roster(ctx)
	if err != nil {
		return nil, err
	}
	return roster.sessions, nil
}
func (b *HerdrBackend) resolve(ctx context.Context, target string) (backendTarget, error) {
	roster, err := b.roster(ctx)
	if err != nil {
		return backendTarget{}, err
	}
	pane, ok := roster.targets[target]
	if !ok {
		return backendTarget{}, ErrTargetNotFound
	}
	return pane, nil
}
func (b *HerdrBackend) Capture(ctx context.Context, target string, lines int) (string, error) {
	captures, err := b.CaptureBatch(ctx, map[string]int{target: lines})
	if err != nil {
		return "", err
	}
	return captures[target], nil
}

// CaptureBatch shares one fresh roster across a bounded read-only operation.
// No results are returned if any target is stale or any pane read fails.
func (b *HerdrBackend) CaptureBatch(ctx context.Context, targets map[string]int) (map[string]string, error) {
	if len(targets) > 64 {
		return nil, errors.New("capture batch exceeds 64 targets")
	}
	keys := make([]string, 0, len(targets))
	for target, lines := range targets {
		if lines < 1 || lines > 2000 {
			return nil, errors.New("capture lines must be between 1 and 2000")
		}
		keys = append(keys, target)
	}
	sort.Strings(keys)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	captures := make(map[string]string, len(targets))
	if len(targets) == 0 {
		return captures, nil
	}
	roster, err := b.roster(ctx)
	if err != nil {
		return nil, err
	}
	for _, target := range keys {
		if _, ok := roster.targets[target]; !ok {
			return nil, ErrTargetNotFound
		}
	}
	for _, target := range keys {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		pane := roster.targets[target]
		data, err := b.run(ctx, "--session", pane.session, "pane", "read", pane.pane.ID, "--source", "visible", "--lines", strconv.Itoa(targets[target]), "--format", "text")
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		captures[target] = string(data)
	}
	return captures, nil
}
func (b *HerdrBackend) Send(ctx context.Context, target, text string) error {
	if strings.TrimSpace(text) == "" || len(text) > 64<<10 || strings.ContainsRune(text, 0) {
		return errors.New("invalid prompt text")
	}
	pane, err := b.resolve(ctx, target)
	if err != nil {
		return err
	}
	if strings.TrimSpace(pane.pane.Agent) == "" {
		return ErrNotAgent
	}
	// Herdr reads target/text positionally and parses options only afterward.
	// An extra "--" would itself become the target.
	_, err = b.run(ctx, "--session", pane.session, "agent", "prompt", pane.pane.ID, text)
	return err
}
