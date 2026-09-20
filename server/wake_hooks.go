package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// runWakeHooks accepts trusted merged operator config and resolved identities,
// never request-supplied shell commands. Hooks are best-effort and sequential.
// Unlike the legacy CLI, stdin is closed, the entire batch has a ten-second
// ceiling, and children remaining in a hook's process group are killed.
func runWakeHooks(ctx context.Context, config map[string]any, oracle, session, window string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	hooks, _ := config["hooks"].(map[string]any)
	entries, _ := hooks["postWake"].([]any)
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		hook, ok := entry.(string)
		if !ok {
			continue
		}
		hook = strings.TrimSpace(hook)
		if hook == "" {
			continue
		}
		cmd := exec.CommandContext(ctx, "sh", "-c", hook)
		cmd.Env = append(os.Environ(), "MAW_ORACLE="+oracle, "MAW_SESSION="+session, "MAW_WINDOW="+window)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
		cmd.WaitDelay = time.Second
		// nil streams map to the null device; Dir intentionally inherits process cwd.
		if cmd.Start() != nil {
			continue
		}
		_ = cmd.Wait()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
