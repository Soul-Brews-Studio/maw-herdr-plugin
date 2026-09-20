package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

var errConfig = errors.New("config_unavailable")

type configLayer struct {
	path   string
	weight uint64
	scope  int
	local  bool
}
type publicConfig struct {
	Node       string
	Agents     map[string]string
	NamedPeers []map[string]string
	HasPeers   bool
}

// Reject unsafe static paths; unreadable/missing ordinary layers remain optional.
func configPathSafe(path string) error {
	path, e := filepath.Abs(path)
	if e != nil {
		return errConfig
	}
	for {
		st, e := os.Lstat(path)
		if e == nil && st.Mode()&os.ModeSymlink != 0 {
			return errConfig
		}
		if e != nil && !os.IsNotExist(e) && !os.IsPermission(e) {
			return errConfig
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}
func configFile(path string, used *int) (map[string]any, error) {
	if e := configPathSafe(path); e != nil {
		return nil, e
	}
	st, e := os.Lstat(path)
	if e != nil {
		return nil, nil
	}
	if !st.Mode().IsRegular() {
		return nil, errConfig
	}
	if st.Size() > 1<<20 {
		return nil, errConfig
	}
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, nil
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	after, e := f.Stat()
	if e != nil || !os.SameFile(st, after) {
		return nil, errConfig
	}
	b, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	*used += len(b)
	if len(b) > 1<<20 || *used > 4<<20 {
		return nil, errConfig
	}
	if e != nil {
		return nil, nil
	}
	if !utf8.Valid(b) {
		return nil, nil
	}
	depth := 0
	quoted, escaped := false, false
	for _, c := range b {
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
		} else if c == '{' || c == '[' {
			depth++
			if depth > 64 {
				return nil, errConfig
			}
		} else if c == '}' || c == ']' {
			depth--
		}
	}
	var value map[string]any
	if json.Unmarshal(b, &value) != nil {
		return nil, nil
	}
	return value, nil
}
func configScan(dir string, scope int) ([]configLayer, error) {
	if e := configPathSafe(dir); e != nil {
		return nil, e
	}
	if st, e := os.Lstat(dir); e == nil && !st.IsDir() {
		return nil, errConfig
	}
	f, e := os.Open(dir)
	if e != nil {
		return nil, nil
	}
	defer f.Close()
	entries, e := f.ReadDir(1025)
	if len(entries) > 1024 {
		return nil, errConfig
	}
	if e != nil && e != io.EOF {
		return nil, nil
	}
	out := []configLayer{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "maw.config.") {
			continue
		}
		rest := strings.TrimPrefix(name, "maw.config.")
		local := strings.HasSuffix(rest, ".local.json")
		suffix := ".json"
		if local {
			suffix = ".local.json"
		}
		if !strings.HasSuffix(rest, suffix) {
			continue
		}
		digits := strings.TrimSuffix(rest, suffix)
		if digits == "" {
			continue
		}
		valid := true
		for _, r := range digits {
			if r < '0' || r > '9' {
				valid = false
			}
		}
		n, e := strconv.ParseUint(digits, 10, 32)
		if !valid || e != nil {
			continue
		}
		out = append(out, configLayer{filepath.Join(dir, name), n, scope, local})
	}
	return out, nil
}
func configUser(dir string, scope int) ([]configLayer, error) {
	layers, e := configScan(dir, scope)
	if e != nil || len(layers) > 0 {
		return layers, e
	}
	path := filepath.Join(dir, "maw.config.json")
	if _, e := os.Lstat(path); e == nil {
		layers = append(layers, configLayer{path, 50, scope, false})
	}
	return layers, nil
}
func mergeConfig(dst, src map[string]any) {
	for k, v := range src {
		if v == nil {
			delete(dst, k)
			continue
		}
		if obj, ok := v.(map[string]any); ok {
			base, _ := dst[k].(map[string]any)
			if base == nil {
				base = map[string]any{}
			}
			mergeConfig(base, obj)
			dst[k] = base
			continue
		}
		if k == "namedPeers" {
			base, bok := dst[k].([]any)
			items, iok := v.([]any)
			if bok && iok {
				for _, item := range items {
					record, _ := item.(map[string]any)
					name, has := record["name"].(string)
					slot := -1
					if has {
						for i, old := range base {
							m, _ := old.(map[string]any)
							if n, ok := m["name"].(string); ok && n == name {
								slot = i
								break
							}
						}
					}
					if slot >= 0 {
						base[slot] = item
					} else {
						base = append(base, item)
					}
				}
				dst[k] = base
				continue
			}
		}
		dst[k] = v
	}
}
func loadMergedConfig(cwd string) (map[string]any, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return nil, errConfig
	}
	xdg, ok := os.LookupEnv("XDG_CONFIG_HOME")
	if !ok || !filepath.IsAbs(xdg) {
		xdg = filepath.Join(home, ".config")
	}
	singleton := filepath.Join(xdg, "maw")
	active := singleton
	mawHome, hasHome := os.LookupEnv("MAW_HOME")
	configDir, hasDir := os.LookupEnv("MAW_CONFIG_DIR")
	if hasHome {
		active = filepath.Join(mawHome, "config")
	} else if hasDir {
		active = configDir
	}
	layers, e := configUser(active, 20)
	if e != nil {
		return nil, e
	}
	chain := []string{}
	for i := 0; i < 32; i++ {
		chain = append(chain, cwd)
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	for i := len(chain) - 1; i >= 0; i-- {
		more, e := configScan(filepath.Join(chain[i], ".maw"), 30+len(chain)-1-i)
		if e != nil {
			return nil, e
		}
		layers = append(layers, more...)
	}
	if hasHome && !hasDir && os.Getenv("MAW_TEST_MODE") != "1" && filepath.Clean(active) != filepath.Clean(singleton) {
		more, e := configUser(singleton, 10)
		if e != nil {
			return nil, e
		}
		seen := map[string]bool{}
		for _, l := range layers {
			seen[l.path] = true
		}
		for _, l := range more {
			if !seen[l.path] {
				layers = append(layers, l)
			}
		}
	}
	if len(layers) > 128 {
		return nil, errConfig
	}
	sort.SliceStable(layers, func(i, j int) bool {
		a, b := layers[i], layers[j]
		if a.weight != b.weight {
			return a.weight < b.weight
		}
		if a.scope != b.scope {
			return a.scope < b.scope
		}
		if a.local != b.local {
			return !a.local
		}
		return a.path < b.path
	})
	merged := map[string]any{}
	used := 0
	loaded := false
	fallback := filepath.Join(active, "maw.config.json")
	seenFallback := false
	for _, layer := range layers {
		if layer.path == fallback {
			seenFallback = true
		}
		value, e := configFile(layer.path, &used)
		if e != nil {
			return nil, e
		}
		if value != nil {
			loaded = true
			mergeConfig(merged, value)
		}
	}
	if !loaded && !seenFallback {
		value, e := configFile(fallback, &used)
		if e != nil {
			return nil, e
		}
		mergeConfig(merged, value)
	}
	return merged, nil
}
func projectPublicConfig(value map[string]any) publicConfig {
	out := publicConfig{Agents: map[string]string{}, NamedPeers: []map[string]string{}}
	if node, ok := value["node"].(string); ok && strings.TrimSpace(node) != "" {
		out.Node = node
	} else if host, ok := os.LookupEnv("HOSTNAME"); ok {
		out.Node = strings.TrimSpace(host)
		if out.Node == "" {
			out.Node = "local"
		}
	} else {
		host, _ := os.Hostname()
		out.Node = strings.Split(host, ".")[0]
		if out.Node == "" {
			out.Node = "local"
		}
	}
	if agents, ok := value["agents"].(map[string]any); ok {
		for k, v := range agents {
			if str, ok := v.(string); ok {
				out.Agents[k] = str
			}
		}
	}
	peers, present := value["namedPeers"]
	out.HasPeers = present
	add := func(name string, v any) {
		u, ok := v.(string)
		if !ok {
			return
		}
		if _, e := federationURL(u); e == nil {
			out.NamedPeers = append(out.NamedPeers, map[string]string{"name": name, "url": u})
		}
	}
	switch peers := peers.(type) {
	case []any:
		for _, v := range peers {
			m, _ := v.(map[string]any)
			if name, ok := m["name"].(string); ok {
				add(name, m["url"])
			}
		}
	case map[string]any:
		keys := []string{}
		for k := range peers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			add(k, peers[k])
		}
	}
	return out
}
