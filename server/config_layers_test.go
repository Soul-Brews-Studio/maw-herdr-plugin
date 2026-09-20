package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "herdr-config-tests-")
	if err != nil {
		panic(err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		panic(err)
	}
	for _, key := range []string{"MAW_HOME", "MAW_CONFIG_DIR", "MAW_STATE_DIR", "MAW_XDG", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "MAW_SENDER", "MAW_FEDERATION_TOKEN", "MAW_PEER_KEY", "PEERS_FILE"} {
		os.Unsetenv(key)
	}
	os.Setenv("HOME", root)
	os.Setenv("MAW_CONFIG_DIR", filepath.Join(root, "config"))
	os.Setenv("MAW_TEST_MODE", "1")
	if err := os.Chdir(root); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(root)
	os.Exit(code)
}
func writeConfigFixture(t *testing.T, path, raw string) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte(raw), 0600); e != nil {
		t.Fatal(e)
	}
}
func TestLayeredConfigOrderAndMerge(t *testing.T) {
	root := federationTempDir(t)
	user := filepath.Join(root, "config")
	cwd := filepath.Join(root, "project")
	os.MkdirAll(cwd, 0700)
	t.Setenv("MAW_CONFIG_DIR", user)
	writeConfigFixture(t, filepath.Join(user, "maw.config.10.json"), `{"node":"user","agents":{"a":"one","b":"two"},"namedPeers":[{"name":"one","url":"https://old","token":"secret"},{"name":"two","url":"https://two"}]}`)
	writeConfigFixture(t, filepath.Join(cwd, ".maw", "maw.config.10.json"), `{"node":"project","agents":{"a":null,"c":"three"},"namedPeers":[{"name":"one","url":"https://new"}]}`)
	writeConfigFixture(t, filepath.Join(user, "maw.config.20.local.json"), `{"node":"winner","namedPeers":[]}`)
	value, err := loadMergedConfig(cwd)
	if err != nil {
		t.Fatal(err)
	}
	p := projectPublicConfig(value)
	if p.Node != "winner" || len(p.Agents) != 2 || len(p.NamedPeers) != 2 || p.NamedPeers[0]["url"] != "https://new" {
		t.Fatal(p)
	}
	peers := value["namedPeers"].([]any)
	if _, ok := peers[0].(map[string]any)["token"]; ok {
		t.Fatal("named record field merged")
	}
	writeConfigFixture(t, filepath.Join(user, "maw.config.30.json"), `{"namedPeers":null}`)
	value, err = loadMergedConfig(cwd)
	if err != nil || projectPublicConfig(value).HasPeers {
		t.Fatal(value, err)
	}
}
func TestLayeredFallbackProjectionAndBounds(t *testing.T) {
	root := federationTempDir(t)
	t.Setenv("MAW_CONFIG_DIR", root)
	writeConfigFixture(t, filepath.Join(root, "maw.config.20.json"), `broken`)
	writeConfigFixture(t, filepath.Join(root, "maw.config.json"), `{"node":"n","federationToken":"secret","agents":{"a":"n","secret":{"token":"private"}},"namedPeers":[{"name":"good","url":"https://example.test","token":"secret"},{"name":"bad","url":"http://user:secret@host"}]}`)
	value, err := loadMergedConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	p := projectPublicConfig(value)
	b, _ := json.Marshal(p)
	if len(p.NamedPeers) != 1 || len(p.Agents) != 1 || string(b) == "" {
		t.Fatal(p)
	}
	os.Remove(filepath.Join(root, "maw.config.20.json"))
	os.Symlink(filepath.Join(root, "maw.config.json"), filepath.Join(root, "maw.config.20.json"))
	if _, e := loadMergedConfig(root); e == nil {
		t.Fatal("symlink layer accepted")
	}
}
func TestPrivateConfigFreshFallback(t *testing.T) {
	root := federationTempDir(t)
	t.Setenv("MAW_CONFIG_DIR", root)
	t.Setenv("PEERS_FILE", filepath.Join(root, "missing.json"))
	t.Setenv("MAW_PEER_KEY", "fixture")
	t.Setenv("MAW_FEDERATION_TOKEN", "")
	os.Unsetenv("MAW_SENDER")
	t.Cleanup(func() { os.Unsetenv("MAW_SENDER") })
	path := filepath.Join(root, "maw.config.json")
	writeConfigFixture(t, path, `{"node":"node","oracle":"oracle","federationToken":"one"}`)
	c, e := readFederationConfigAt(true, root)
	if e != nil || c.sender != "node:oracle" || c.fleet != "one" {
		t.Fatal(c, e)
	}
	writeConfigFixture(t, path, `{"node":"node","oracle":"oracle","federationToken":"two"}`)
	next, e := readFederationConfigAt(true, root)
	if e != nil || next.fleet != "two" || next.fingerprint == c.fingerprint {
		t.Fatal(e)
	}
	t.Setenv("MAW_SENDER", "")
	next, e = readFederationConfigAt(true, root)
	if e != nil || next.sender != "" {
		t.Fatal("present empty override", e)
	}
}

func TestConfigInheritanceAndStartupSnapshot(t *testing.T) {
	root := federationTempDir(t)
	home := filepath.Join(root, "instance")
	xdg := filepath.Join(root, "xdg")
	t.Setenv("MAW_HOME", home)
	t.Setenv("XDG_CONFIG_HOME", xdg)
	t.Setenv("MAW_TEST_MODE", "")
	old, had := os.LookupEnv("MAW_CONFIG_DIR")
	os.Unsetenv("MAW_CONFIG_DIR")
	t.Cleanup(func() {
		if had {
			os.Setenv("MAW_CONFIG_DIR", old)
		} else {
			os.Unsetenv("MAW_CONFIG_DIR")
		}
	})
	writeConfigFixture(t, filepath.Join(xdg, "maw", "maw.config.10.json"), `{"agents":{"inherited":"yes"},"node":"base"}`)
	path := filepath.Join(home, "config", "maw.config.20.json")
	writeConfigFixture(t, path, `{"node":"snapshot","namedPeers":[]}`)
	value, e := loadMergedConfig(root)
	if e != nil || len(projectPublicConfig(value).Agents) != 1 {
		t.Fatal(value, e)
	}
	t.Setenv("MAW_CONFIG_DIR", "")
	value, e = loadMergedConfig(root)
	if e != nil || len(projectPublicConfig(value).Agents) != 0 {
		t.Fatal("presence must suppress inheritance", value, e)
	}
	s, _ := testServer(t)
	writeConfigFixture(t, path, `{"node":"changed","namedPeers":[{"name":"new","url":"http://localhost"}]}`)
	response := request(s, "GET", "/api/config", "", nil)
	var public map[string]any
	json.Unmarshal(response.Body.Bytes(), &public)
	if response.Code != 200 || public["node"] != "snapshot" || len(public["namedPeers"].([]any)) != 0 {
		t.Fatal(response.Body.String())
	}
}
func TestConfigResourceLimits(t *testing.T) {
	for _, kind := range []string{"depth", "file", "layers", "entries", "aggregate"} {
		t.Run(kind, func(t *testing.T) {
			root := federationTempDir(t)
			t.Setenv("MAW_CONFIG_DIR", root)
			switch kind {
			case "depth":
				writeConfigFixture(t, filepath.Join(root, "maw.config.json"), strings.Repeat(`{"x":`, 65)+`0`+strings.Repeat(`}`, 65))
			case "file":
				writeConfigFixture(t, filepath.Join(root, "maw.config.json"), strings.Repeat(" ", (1<<20)+1))
			case "layers":
				for i := 0; i < 129; i++ {
					writeConfigFixture(t, filepath.Join(root, fmt.Sprintf("maw.config.%d.json", i)), `{}`)
				}
			case "entries":
				for i := 0; i < 1025; i++ {
					writeConfigFixture(t, filepath.Join(root, fmt.Sprintf("junk%d", i)), ``)
				}
			case "aggregate":
				for i := 0; i < 5; i++ {
					writeConfigFixture(t, filepath.Join(root, fmt.Sprintf("maw.config.%d.json", i)), `{"padding":"`+strings.Repeat("x", 900000)+`"}`)
				}
			}
			if _, e := loadMergedConfig(root); e == nil {
				t.Fatal("limit accepted", kind)
			}
		})
	}
}

func TestConfigXDGAbsoluteAndDisplayPreserved(t *testing.T) {
	root := federationTempDir(t)
	t.Setenv("HOME", root)
	old, had := os.LookupEnv("MAW_CONFIG_DIR")
	os.Unsetenv("MAW_CONFIG_DIR")
	t.Cleanup(func() {
		if had {
			os.Setenv("MAW_CONFIG_DIR", old)
		} else {
			os.Unsetenv("MAW_CONFIG_DIR")
		}
	})
	writeConfigFixture(t, filepath.Join(root, ".config", "maw", "maw.config.json"), `{"node":" padded "}`)
	for _, xdg := range []string{"", "relative"} {
		t.Setenv("XDG_CONFIG_HOME", xdg)
		value, e := loadMergedConfig(root)
		if e != nil || projectPublicConfig(value).Node != " padded " {
			t.Fatal(value, e)
		}
	}
}
