package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func hookConfig(entries ...any) map[string]any {
	return map[string]any{"hooks": map[string]any{"postWake": entries}}
}

func TestWakeHooksOrderIdentityAndFailures(t *testing.T) {
	dir := t.TempDir()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	t.Setenv("WAKE_HOOK_INHERITED", "inherited")
	t.Setenv("MAW_ORACLE", "stale")
	config := hookConfig(nil, 42, "  ", "  printf '%s\\n' \"$MAW_ORACLE|$MAW_SESSION|$MAW_WINDOW|$WAKE_HOOK_INHERITED\" > result  ", "exit 7", "bad\x00command", "printf '%s\\n' \"$PWD\" >> result", "printf done >> result")
	runWakeHooks(context.Background(), config, "oracle name", "session name", "window name")
	got, err := os.ReadFile(filepath.Join(dir, "result"))
	if err != nil {
		t.Fatal(err)
	}
	want := "oracle name|session name|window name|inherited\n" + dir + "\ndone"
	if string(got) != want {
		t.Fatalf("got %q want %q", got, want)
	}
	for _, config := range []map[string]any{nil, {}, {"hooks": "invalid"}, {"hooks": map[string]any{"postWake": "invalid"}}} {
		runWakeHooks(context.Background(), config, "", "", "")
	}
}

func TestWakeHooksCancellationStopsChildrenAndLaterHooks(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WAKE_HOOK_DIR", dir)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runWakeHooks(ctx, hookConfig("touch \"$WAKE_HOOK_DIR/started\"; (sleep 0.4; touch \"$WAKE_HOOK_DIR/leaked\") & wait", "touch \"$WAKE_HOOK_DIR/later\""), "", "", "")
		close(done)
	}()
	defer cancel()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hook did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not finish")
	}
	time.Sleep(500 * time.Millisecond)
	for _, name := range []string{"leaked", "later"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("unexpected %s: %v", name, err)
		}
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	runWakeHooks(ctx, hookConfig("touch \"$WAKE_HOOK_DIR/later\""), "", "", "")
	if _, err := os.Stat(filepath.Join(dir, "later")); !os.IsNotExist(err) {
		t.Fatal("pre-cancelled hook ran")
	}
}

func TestWakeHooksDeadlineAndBackgroundCleanup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WAKE_HOOK_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	runWakeHooks(ctx, hookConfig("(sleep 0.4; touch \"$WAKE_HOOK_DIR/deadline-leak\") & wait", "touch \"$WAKE_HOOK_DIR/later\""), "", "", "")
	if time.Since(started) > 2*time.Second {
		t.Fatal("deadline was not bounded")
	}
	runWakeHooks(context.Background(), hookConfig("(sleep 0.4; touch \"$WAKE_HOOK_DIR/background-leak\") &"), "", "", "")
	time.Sleep(500 * time.Millisecond)
	for _, name := range []string{"deadline-leak", "background-leak", "later"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("unexpected %s: %v", name, err)
		}
	}
}
