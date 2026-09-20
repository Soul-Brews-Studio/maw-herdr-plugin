package main

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Header attribution is display-only, not an authenticated identity.
func inboxDisplaySender(ctx context.Context, header, root string, config map[string]any) string {
	raw := strings.TrimSpace(header)
	if raw != "" {
		if a, b, ok := strings.Cut(raw, ":"); ok && strings.TrimSpace(a) != "" && strings.TrimSpace(b) != "" {
			return strings.TrimSpace(b) + ":" + strings.TrimSpace(a)
		}
		return raw
	}
	node, ok := config["node"].(string)
	if !ok {
		node = "local"
	}
	return node + ":" + inboxSenderOracle(ctx, root, config)
}
func inboxTmuxWindow(ctx context.Context, pane string) string {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	args := []string{"display-message"}
	if pane != "" {
		args = append(args, "-t", pane)
	}
	args = append(args, "-p", "#{window_name}")
	cmd := exec.CommandContext(ctx, "tmux", args...)
	cmd.WaitDelay = time.Second
	out := &limitedOutput{limit: 4096}
	cmd.Stdout = out
	if cmd.Run() != nil {
		return ""
	}
	return strings.TrimSpace(out.String())
}
func inboxWindowOracle(value string) string {
	value = strings.TrimSpace(value)
	if _, b, ok := strings.Cut(value, ":"); ok {
		value = strings.TrimSpace(b)
	}
	if i := strings.LastIndex(value, "."); i >= 0 && value[i+1:] != "" && inboxDigits(value[i+1:]) {
		value = value[:i]
	}
	return strings.TrimSpace(value)
}
func inboxCleanOracle(value string) string {
	value = strings.Trim(strings.TrimSpace(value), "\"'`")
	if i := strings.IndexAny(value, " \t@(["); i >= 0 {
		value = value[:i]
	}
	for strings.HasSuffix(value, ".git") {
		value = strings.TrimSuffix(value, ".git")
	}
	for strings.HasSuffix(value, "-oracle") {
		value = strings.TrimSuffix(value, "-oracle")
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return ""
		}
	}
	return value
}
func inboxSenderOracle(ctx context.Context, root string, config map[string]any) string {
	if pane := os.Getenv("TMUX_PANE"); strings.TrimSpace(pane) != "" {
		if w := inboxTmuxWindow(ctx, pane); w != "" {
			return w
		}
	}
	for dir := root; dir != ""; dir = filepath.Dir(dir) {
		fd, err := syscall.Open(filepath.Join(dir, "CLAUDE.md"), syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		var f *os.File
		if err == nil {
			f = os.NewFile(uintptr(fd), "CLAUDE.md")
			st, e := f.Stat()
			if e != nil || !st.Mode().IsRegular() || st.Size() > 1<<20 {
				f.Close()
				err = errInboxUnavailable
			}
		}
		if err == nil {
			scan := bufio.NewScanner(io.LimitReader(f, 1<<20))
			found := ""
			for n := 0; n < 120 && scan.Scan(); n++ {
				line := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(scan.Text()), "#-*"))
				for _, p := range []string{"oracle:", "oracle =", "identity:", "name:"} {
					if strings.HasPrefix(strings.ToLower(line), p) {
						found = inboxCleanOracle(line[len(p):])
						if found != "" {
							break
						}
					}
				}
				if found == "" && strings.HasSuffix(line, "-oracle") {
					found = inboxCleanOracle(line)
				}
				if found != "" {
					break
				}
			}
			f.Close()
			if found != "" {
				return found
			}
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	if w := os.Getenv("MAW_SESSION_WINDOW"); strings.TrimSpace(w) != "" {
		if o := inboxWindowOracle(w); o != "" {
			return o
		}
		return "mawjs"
	}
	if o, _ := config["oracle"].(string); strings.TrimSpace(o) != "" {
		return strings.TrimSpace(o)
	}
	if _, ok := os.LookupEnv("TMUX"); ok {
		w := inboxWindowOracle(inboxTmuxWindow(ctx, ""))
		if w == "" {
			w = "mawjs"
		}
		return "pane/" + w
	}
	for dir := root; dir != ""; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return "job/" + filepath.Base(dir)
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return "pane/unknown"
}
