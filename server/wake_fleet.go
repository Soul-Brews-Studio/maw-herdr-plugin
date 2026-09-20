package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type wakeFleetOutput struct{ strings.Builder }

func (w *wakeFleetOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > 65536 {
		return 0, errWakeFleet
	}
	return w.Builder.Write(p)
}

type wakeFleetLiveWindow struct{ Name, Cwd string }
type wakeFleetWindow struct {
	Name string `json:"name"`
	Repo string `json:"repo"`
	Kind string `json:"kind,omitempty"`
}

var errWakeFleet = errors.New("wake fleet registration failed")

const wakeFleetLimit = 1 << 20

func wakeFleetSlug(path string) string {
	if p, e := filepath.EvalSymlinks(path); e == nil {
		path = p
	}
	parts := strings.Split(filepath.Clean(path), string(filepath.Separator))
	for i, p := range parts {
		if p == "github.com" && i+2 < len(parts) {
			return "github.com/" + parts[i+1] + "/" + parts[i+2]
		}
	}
	return ""
}
func wakeFleetStorage(repo string) string {
	return strings.TrimPrefix(strings.TrimSpace(repo), "github.com/")
}
func wakeFleetStem(s string) string {
	a, b, ok := strings.Cut(s, "-")
	if ok && a != "" {
		for _, c := range a {
			if c < '0' || c > '9' {
				return s
			}
		}
		return b
	}
	return s
}
func wakeFleetKind(s string) string {
	s = strings.TrimSpace(s)
	if s == "oracle" || s == "project" {
		return s
	}
	return ""
}
func wakeFleetKey(root, repo string) string {
	repo = wakeFleetStorage(repo)
	if repo == "" {
		return ""
	}
	p := filepath.Join(root, "github.com", repo)
	if filepath.IsAbs(repo) {
		p = repo
	}
	if c, e := filepath.EvalSymlinks(p); e == nil {
		return c
	}
	return p
}
func wakeFleetCollect(live []wakeFleetLiveWindow, base, window, root string) []wakeFleetWindow {
	out := []wakeFleetWindow{}
	seen := map[string]bool{}
	for _, w := range live {
		repo := wakeFleetSlug(w.Cwd)
		if repo == "" {
			continue
		}
		name := w.Name
		if name == "" {
			name = "main"
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		kind := "project"
		if strings.HasSuffix(strings.TrimSpace(name), "-oracle") {
			kind = "oracle"
		}
		out = append(out, wakeFleetWindow{name, repo, kind})
	}
	if repo := wakeFleetSlug(base); repo != "" {
		kind := "project"
		psi, e1 := os.Stat(filepath.Join(base, "ψ"))
		claude, e2 := os.Stat(filepath.Join(base, "CLAUDE.md"))
		if strings.HasSuffix(filepath.Base(base), "-oracle") || (e1 == nil && psi.IsDir() && e2 == nil && claude.Mode().IsRegular()) {
			kind = "oracle"
		}
		found := false
		for i := range out {
			if out[i].Name == window {
				out[i].Repo = repo
				out[i].Kind = kind
				found = true
			} else if wakeFleetKey(root, out[i].Repo) == wakeFleetKey(root, repo) {
				out[i].Kind = kind
			}
		}
		if !found {
			out = append(out, wakeFleetWindow{window, repo, kind})
		}
	}
	return out
}
func wakeFleetMerge(existing any, updates []wakeFleetWindow, root string) []wakeFleetWindow {
	out := []wakeFleetWindow{}
	if items, ok := existing.([]any); ok {
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			if strings.TrimSpace(name) == "" {
				continue
			}
			repo, _ := m["repo"].(string)
			kind, _ := m["kind"].(string)
			out = append(out, wakeFleetWindow{name, wakeFleetStorage(repo), wakeFleetKind(kind)})
		}
	}
	oldCount, newCount := map[string]int{}, map[string]int{}
	for _, w := range out {
		oldCount[wakeFleetKey(root, w.Repo)]++
	}
	for _, w := range updates {
		if strings.TrimSpace(w.Name) != "" {
			newCount[wakeFleetKey(root, w.Repo)]++
		}
	}
	for _, w := range updates {
		if strings.TrimSpace(w.Name) == "" {
			continue
		}
		w.Repo = wakeFleetStorage(w.Repo)
		key := wakeFleetKey(root, w.Repo)
		matched := false
		for i := range out {
			if out[i].Name == w.Name {
				out[i].Repo = w.Repo
				if w.Kind != "" {
					out[i].Kind = w.Kind
				}
				matched = true
				break
			}
		}
		if !matched && oldCount[key] == 1 && newCount[key] == 1 {
			for i := range out {
				if wakeFleetKey(root, out[i].Repo) == key {
					out[i] = w
					matched = true
					break
				}
			}
		}
		if !matched {
			out = append(out, w)
		}
	}
	return out
}

// Refuse symlinks in registry paths, including ancestors. Missing suffixes are allowed.
func wakeFleetSafe(path string) error {
	if !filepath.IsAbs(path) {
		return errWakeFleet
	}
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		st, e := os.Lstat(p)
		if e != nil && !os.IsNotExist(e) {
			return errWakeFleet
		}
		if e == nil && st.Mode()&os.ModeSymlink != 0 {
			return errWakeFleet
		}
		if p == filepath.Dir(p) {
			break
		}
	}
	return nil
}
func wakeFleetRead(path string) (map[string]any, error) {
	if wakeFleetSafe(path) != nil {
		return nil, errWakeFleet
	}
	before, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !before.Mode().IsRegular() {
		return nil, errWakeFleet
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > wakeFleetLimit {
		return nil, errWakeFleet
	}
	data, e := io.ReadAll(io.LimitReader(f, wakeFleetLimit+1))
	if e != nil || len(data) > wakeFleetLimit || !utf8.Valid(data) {
		return nil, errWakeFleet
	}
	var obj map[string]any
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.UseNumber()
	if d.Decode(&obj) != nil || obj == nil {
		return nil, errWakeFleet
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errWakeFleet
	}
	return obj, nil
}
func wakeFleetDirs(home string) []string {
	legacy := filepath.Join(home, ".maw")
	state := legacy
	config := ""
	if v, ok := os.LookupEnv("MAW_HOME"); ok {
		state = v
		config = filepath.Join(v, "config")
	} else {
		if v, ok := os.LookupEnv("MAW_STATE_DIR"); ok {
			state = v
		} else if v := strings.ToLower(os.Getenv("MAW_XDG")); v == "1" || v == "true" || v == "yes" || v == "on" {
			state = os.Getenv("XDG_STATE_HOME")
			if !filepath.IsAbs(state) {
				state = filepath.Join(home, ".local", "state")
			}
			state = filepath.Join(state, "maw")
		}
		if v, ok := os.LookupEnv("MAW_CONFIG_DIR"); ok {
			config = v
		} else {
			config = os.Getenv("XDG_CONFIG_HOME")
			if !filepath.IsAbs(config) {
				config = filepath.Join(home, ".config")
			}
			config = filepath.Join(config, "maw")
		}
	}
	out := []string{}
	seen := map[string]bool{}
	for _, p := range []string{state, legacy, config} {
		p = filepath.Join(p, "fleet")
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}
func registerWakeFleet(session string, live []wakeFleetLiveWindow, basePath, window string) error {
	if session == "" || len(session) > 255 || strings.TrimSpace(session) != session || strings.HasPrefix(session, "-") || strings.ContainsAny(session, "/\\") || strings.IndexFunc(session, unicode.IsControl) >= 0 || session == "." || session == ".." || len(live) > 1024 {
		return errWakeFleet
	}
	home := os.Getenv("HOME")
	if !filepath.IsAbs(home) {
		return errWakeFleet
	}
	root, hasRoot := os.LookupEnv("GHQ_ROOT")
	if !hasRoot {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "config", "--get", "ghq.root")
		var output wakeFleetOutput
		cmd.Stdout = &output
		_ = cmd.Run()
		root = strings.TrimSpace(output.String())
		if strings.HasPrefix(root, "~/") {
			root = filepath.Join(home, root[2:])
		}
		if root == "" {
			root = filepath.Join(home, "Code")
		}
	}
	if filepath.Base(root) == "github.com" {
		root = filepath.Dir(root)
	}
	updates := wakeFleetCollect(live, basePath, window, root)
	if len(updates) == 0 {
		return nil
	}
	type entry struct {
		path, name string
		obj        map[string]any
	}
	entries := []entry{}
	seen := map[string]bool{}
	count := 0
	aggregate := int64(0)
	for _, dir := range wakeFleetDirs(home) {
		if wakeFleetSafe(dir) != nil {
			return errWakeFleet
		}
		f, e := os.Open(dir)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return errWakeFleet
		}
		files, e := f.Readdirnames(1025)
		f.Close()
		if e != nil && e != io.EOF {
			return errWakeFleet
		}
		count += len(files)
		if count > 1024 {
			return errWakeFleet
		}
		sort.Strings(files)
		current := map[string]bool{}
		for _, name := range files {
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			path := filepath.Join(dir, name)
			st, e := os.Lstat(path)
			if e != nil {
				return errWakeFleet
			}
			aggregate += st.Size()
			if aggregate > 4*wakeFleetLimit {
				return errWakeFleet
			}
			obj, e := wakeFleetRead(path)
			if e != nil {
				return errWakeFleet
			}
			n, _ := obj["name"].(string)
			if n == "" || seen[n] {
				continue
			}
			if _, squad := obj["members"]; squad {
				continue
			}
			entries = append(entries, entry{path, n, obj})
			current[n] = true
		}
		for n := range current {
			seen[n] = true
		}
	}
	target := filepath.Join(home, ".maw", "fleet", session+".json")
	var obj map[string]any
	for _, e := range entries {
		if e.name == session {
			target = e.path
			obj = e.obj
			break
		}
	}
	if obj == nil {
		keys := map[string]bool{}
		for _, w := range updates {
			keys[wakeFleetKey(root, w.Repo)] = true
		}
		for _, e := range entries {
			if wakeFleetStem(e.name) != wakeFleetStem(session) {
				continue
			}
			for _, w := range wakeFleetMerge(e.obj["windows"], nil, root) {
				if keys[wakeFleetKey(root, w.Repo)] {
					target = e.path
					obj = e.obj
					break
				}
			}
			if obj != nil {
				break
			}
		}
	}
	if obj == nil {
		existing, e := wakeFleetRead(target)
		if e == nil {
			obj = existing
			if _, squad := obj["members"]; squad {
				return errWakeFleet
			}
		} else if os.IsNotExist(e) {
			obj = map[string]any{}
		} else {
			return errWakeFleet
		}
	}
	obj["name"] = session
	obj["created_by"] = "maw wake"
	obj["auto_registered"] = true
	if _, ok := obj["created_at"]; !ok {
		obj["created_at"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	obj["windows"] = wakeFleetMerge(obj["windows"], updates, root)
	data, e := json.MarshalIndent(obj, "", "  ")
	if e != nil || len(data) >= wakeFleetLimit {
		return errWakeFleet
	}
	if wakeFleetSafe(target) != nil {
		return errWakeFleet
	}
	dir := filepath.Dir(target)
	if os.MkdirAll(dir, 0700) != nil {
		return errWakeFleet
	}
	f, e := os.CreateTemp(dir, ".wake-fleet-*")
	if e != nil {
		return errWakeFleet
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, e = f.Write(append(data, '\n')); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil || closeErr != nil {
		return errWakeFleet
	}
	if wakeFleetSafe(target) != nil {
		return errWakeFleet
	}
	if os.Rename(tmp, target) != nil {
		return errWakeFleet
	}
	return nil
}
