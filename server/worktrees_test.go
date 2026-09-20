package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git fixture %v: %v %s", args, err, out)
	}
	return string(out)
}
func worktreeFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	base := t.TempDir()
	home := filepath.Join(base, "home")
	os.Mkdir(home, 0700)
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_AUTHOR_NAME", "Fixture")
	t.Setenv("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Fixture")
	t.Setenv("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
	root := filepath.Join(base, "main")
	os.Mkdir(root, 0700)
	fixtureGit(t, root, "init", "--initial-branch=main")
	os.WriteFile(filepath.Join(root, "file"), []byte("seed"), 0600)
	fixtureGit(t, root, "add", "file")
	fixtureGit(t, root, "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
	target := filepath.Join(base, "main.wt-พื้นที่ space")
	fixtureGit(t, root, "worktree", "add", "-b", "feature", target)
	s, _ := testServer(t)
	s.worktreeRoot = worktreeCanonical(root)
	return s, root, worktreeCanonical(target)
}
func cleanupRequest(s *Server, path string) int {
	body, _ := json.Marshal(map[string]string{"path": path})
	return request(s, "POST", "/api/worktrees/cleanup", string(body), nil).Code
}
func TestWorktreeActualListAndCleanRemoval(t *testing.T) {
	s, root, target := worktreeFixture(t)
	w := request(s, "GET", "/api/worktrees", "", nil)
	var rows []worktreeEntry
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil || w.Code != 200 || len(rows) != 2 {
		t.Fatal(w.Code, w.Body, err)
	}
	found := false
	for _, row := range rows {
		if row.Path == target {
			found = true
			if row.Branch != "feature" || row.Status != "stale" || row.MainRepo != "main" || row.Name != "พื้นที่ space" {
				t.Fatal(row)
			}
		}
	}
	if !found {
		t.Fatal(rows)
	}
	if code := cleanupRequest(s, target); code != 200 {
		t.Fatal(code)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("target remains", err)
	}
	if branch := fixtureGit(t, root, "show-ref", "--verify", "refs/heads/feature"); branch == "" {
		t.Fatal("branch deleted")
	}
}
func TestWorktreeCleanupRefusesProtectedTargets(t *testing.T) {
	for _, kind := range []string{"dirty", "untracked", "locked", "active", "current", "main", "unregistered", "outside", "traversal", "option", "backend"} {
		t.Run(kind, func(t *testing.T) {
			s, root, target := worktreeFixture(t)
			candidate := target
			switch kind {
			case "dirty":
				os.WriteFile(filepath.Join(target, "file"), []byte("changed"), 0600)
			case "untracked":
				os.WriteFile(filepath.Join(target, "untracked"), []byte("new"), 0600)
			case "locked":
				fixtureGit(t, root, "worktree", "lock", target)
			case "active":
				s.backend = &worktreeActiveBackend{cwd: filepath.Join(target, "subdirectory")}
			case "current":
				s.worktreeRoot = target
			case "main":
				s.worktreeRoot = target
				candidate = root
			case "unregistered":
				candidate = filepath.Join(filepath.Dir(root), "unregistered")
				os.MkdirAll(filepath.Join(candidate, ".git"), 0700)
			case "outside":
				candidate = filepath.Join(t.TempDir(), "outside")
				fixtureGit(t, root, "worktree", "add", "-b", "outside", candidate)
			case "traversal":
				candidate = filepath.Dir(target) + "/../" + filepath.Base(filepath.Dir(target)) + "/" + filepath.Base(target)
			case "option":
				candidate = filepath.Join(filepath.Dir(target), "--bad")
			case "backend":
				s.backend = &fakeBackend{failure: true}
			}
			if code := cleanupRequest(s, candidate); code != 400 {
				t.Fatal(kind, code)
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatal("fixture removed", err)
			}
		})
	}
}

type worktreeActiveBackend struct {
	fakeBackend
	cwd string
}

func (b *worktreeActiveBackend) Sessions(context.Context) ([]Session, error) {
	return []Session{{Name: "main", Windows: []Window{{Index: 1, Cwd: b.cwd}}}}, nil
}
func TestWorktreeAuthMethodsAndEnvironment(t *testing.T) {
	s, root, target := worktreeFixture(t)
	r := httptest.NewRequest("POST", "http://localhost/api/worktrees/cleanup", strings.NewReader(fmt.Sprintf(`{"path":%q}`, target)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if code := request(s, "GET", "/api/worktrees/cleanup", "", nil).Code; code != 405 {
		t.Fatal(code)
	}
	if code := request(s, "POST", "/api/worktrees", "{}", nil).Code; code != 405 {
		t.Fatal(code)
	}
	if code := request(s, "GET", "/api/worktrees?root=/elsewhere", "", nil).Code; code != 400 {
		t.Fatal(code)
	}
	t.Setenv("GIT_DIR", "/does-not-exist")
	t.Setenv("GIT_WORK_TREE", "/does-not-exist")
	if entries, err := scanWorktrees(context.Background(), root); err != nil || len(entries) != 2 {
		t.Fatal(entries, err)
	}
}
func TestWorktreeNULParsingAndLimits(t *testing.T) {
	entries, err := parseWorktrees([]byte("worktree /tmp/พื้นที่ space\x00HEAD abc\x00branch refs/heads/topic\x00\x00worktree /tmp/missing\x00prunable reason\x00\x00"))
	if err != nil || len(entries) != 2 || !entries[1].prunable {
		t.Fatal(entries, err)
	}
	rows := worktreeRows("/tmp/main", entries)
	if rows[0].Path == "/tmp/missing" && rows[0].Status != "orphan" {
		t.Fatal(rows)
	}
	if _, err := parseWorktrees([]byte(strings.Repeat("worktree /tmp/x\x00\x00", 129))); err == nil {
		t.Fatal("entry limit ignored")
	}
	if _, err := parseWorktrees([]byte("not nul")); err == nil {
		t.Fatal("malformed accepted")
	}
}
func TestWorktreeRunnerBoundsAndSanitizesFailure(t *testing.T) {
	for _, script := range []string{"head -c 5000000 /dev/zero", "sleep 30", "echo private-secret >&2; exit 1"} {
		dir := t.TempDir()
		binary := filepath.Join(dir, "git")
		os.WriteFile(binary, []byte("#!/bin/sh\n"+script+"\n"), 0700)
		t.Setenv("PATH", dir+":/usr/bin:/bin")
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		start := time.Now()
		_, err := worktreeGit(ctx, dir, "worktree", "list")
		cancel()
		if err == nil || strings.Contains(err.Error(), "private-secret") || time.Since(start) > 2*time.Second {
			t.Fatal(err, time.Since(start))
		}
	}
}

func TestWorktreeStartupRootDoesNotFollowLaterCwd(t *testing.T) {
	_, root, _ := worktreeFixture(t)
	before, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(before); err != nil {
			t.Error(err)
		}
	})
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	s, err := NewServer(Config{Token: testToken}, &fakeBackend{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if s.worktreeRoot != worktreeCanonical(root) {
		t.Fatal("startup root changed", s.worktreeRoot)
	}
	if w := request(s, "GET", "/api/worktrees", "", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
}
