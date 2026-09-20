package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

var errWorktree = errors.New("worktree operation unavailable")

type worktreeEntry struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"`
	Repo     string `json:"repo"`
	MainRepo string `json:"mainRepo"`
	Name     string `json:"name"`
	Status   string `json:"status"`
}
type gitWorktree struct {
	path, branch string
	prunable     bool
}

func worktreeGit(ctx context.Context, root string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	git, err := exec.LookPath("git")
	if err != nil || !filepath.IsAbs(git) {
		return nil, errWorktree
	}
	argv := append([]string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root}, args...)
	cmd := exec.CommandContext(ctx, git, argv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out := &terminalStderr{output: limitedOutput{limit: 4 << 20}, cancel: cancel}
	stderr := &terminalStderr{output: limitedOutput{limit: 64 << 10}, cancel: cancel}
	cmd.Stdout, cmd.Stderr = out, stderr
	defer func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}()
	if err := cmd.Run(); err != nil {
		return nil, errWorktree
	}
	return out.output.Bytes(), nil
}
func parseWorktrees(data []byte) ([]gitWorktree, error) {
	if len(data) > 4<<20 || !utf8.Valid(data) || len(data) == 0 || data[len(data)-1] != 0 {
		return nil, errWorktree
	}
	result := []gitWorktree{}
	var current *gitWorktree
	for _, raw := range bytes.Split(data, []byte{0}) {
		field := string(raw)
		if field == "" {
			current = nil
			continue
		}
		if strings.HasPrefix(field, "worktree ") {
			if current != nil || len(result) >= 128 {
				return nil, errWorktree
			}
			path := strings.TrimPrefix(field, "worktree ")
			if !filepath.IsAbs(path) {
				return nil, errWorktree
			}
			result = append(result, gitWorktree{path: path})
			current = &result[len(result)-1]
			continue
		}
		if current == nil {
			return nil, errWorktree
		}
		if strings.HasPrefix(field, "branch ") {
			current.branch = strings.TrimPrefix(field, "branch ")
		}
		if field == "prunable" || strings.HasPrefix(field, "prunable ") {
			current.prunable = true
		}
	}
	if len(result) == 0 {
		return nil, errWorktree
	}
	return result, nil
}
func worktreeCanonical(path string) string {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return canonical
}
func worktreeValidText(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && !strings.HasPrefix(value, "-") && !strings.ContainsFunc(value, unicode.IsControl)
}
func scanWorktrees(ctx context.Context, root string) ([]gitWorktree, error) {
	if !filepath.IsAbs(root) || strings.ContainsFunc(root, unicode.IsControl) {
		return nil, errWorktree
	}
	data, err := worktreeGit(ctx, root, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	return parseWorktrees(data)
}
func worktreeRows(root string, entries []gitWorktree) []worktreeEntry {
	rows := []worktreeEntry{}
	for _, entry := range entries {
		path := worktreeCanonical(entry.path)
		repo := filepath.Base(path)
		if !worktreeValidText(repo) {
			repo = "worktree"
		}
		main := filepath.Base(root)
		if !worktreeValidText(main) {
			main = repo
		}
		name := repo
		if _, suffix, ok := strings.Cut(repo, ".wt-"); ok {
			name = suffix
		}
		branch := strings.TrimPrefix(entry.branch, "refs/heads/")
		if !worktreeValidText(branch) {
			branch = "unknown"
		}
		status := "stale"
		if entry.prunable {
			status = "orphan"
		}
		rows = append(rows, worktreeEntry{Path: path, Branch: branch, Repo: repo, MainRepo: main, Name: name, Status: status})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	return rows
}
func withinWorktree(parent, path string) bool {
	relative, err := filepath.Rel(parent, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
func (s *Server) cleanupWorktree(ctx context.Context, raw string) (string, []string, error) {
	if !filepath.IsAbs(raw) || len(raw) > 4096 || strings.ContainsFunc(raw, unicode.IsControl) {
		return "", nil, errWorktree
	}
	for _, part := range strings.Split(raw, string(filepath.Separator)) {
		if part == ".." || strings.HasPrefix(part, "-") {
			return "", nil, errWorktree
		}
	}
	target, err := filepath.EvalSymlinks(raw)
	if err != nil || target == s.worktreeRoot || !withinWorktree(filepath.Dir(s.worktreeRoot), target) {
		return "", nil, errWorktree
	}
	if strings.ContainsFunc(target, unicode.IsControl) {
		return "", nil, errWorktree
	}
	for _, part := range strings.Split(target, string(filepath.Separator)) {
		if strings.HasPrefix(part, "-") {
			return "", nil, errWorktree
		}
	}
	if _, err := os.Stat(filepath.Join(target, ".git")); err != nil {
		return "", nil, errWorktree
	}
	entries, err := scanWorktrees(ctx, s.worktreeRoot)
	if err != nil {
		return "", nil, err
	}
	if target == worktreeCanonical(entries[0].path) {
		return "", nil, errWorktree
	}
	registered := false
	for _, entry := range entries {
		if worktreeCanonical(entry.path) == target {
			registered = true
		}
	}
	if !registered {
		return "", nil, errWorktree
	}
	sessions, err := s.backend.Sessions(ctx)
	if err != nil {
		return "", nil, errWorktree
	}
	for _, session := range sessions {
		for _, window := range session.Windows {
			if window.Cwd == "" {
				continue
			}
			if !filepath.IsAbs(window.Cwd) {
				return "", nil, errWorktree
			}
			if withinWorktree(target, filepath.Clean(window.Cwd)) || withinWorktree(target, worktreeCanonical(window.Cwd)) {
				return "", nil, errWorktree
			}
		}
	}
	output, err := worktreeGit(ctx, s.worktreeRoot, "worktree", "remove", "--", target)
	if err != nil {
		return "", nil, err
	}
	log := []string{}
	if text := strings.TrimSpace(string(output)); text != "" {
		log = append(log, text)
	}
	return target, log, nil
}
func (s *Server) serveWorktrees(w http.ResponseWriter, r *http.Request) {
	cleanup := r.URL.Path == "/api/worktrees/cleanup"
	method := "GET"
	status := 500
	reason := "worktrees_unavailable"
	if cleanup {
		method = "POST"
		status = 400
		reason = "worktree_cleanup_rejected"
	}
	if r.Method != method {
		methodNotAllowed(w, method)
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		fail(w, 400, "worktree_query_not_supported")
		return
	}
	select {
	case s.worktreeSlots <- struct{}{}:
		defer func() { <-s.worktreeSlots }()
	default:
		fail(w, status, reason)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if !cleanup {
		entries, err := scanWorktrees(ctx, s.worktreeRoot)
		if err != nil {
			fail(w, status, reason)
			return
		}
		writeJSON(w, 200, worktreeRows(s.worktreeRoot, entries))
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &body, 8192) {
		return
	}
	path, log, err := s.cleanupWorktree(ctx, body.Path)
	if err != nil {
		fail(w, status, reason)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "path": path, "log": log})
}
