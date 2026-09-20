package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func isolatedFederation(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for _, key := range []string{"MAW_HOME", "MAW_STATE_DIR", "MAW_XDG", "XDG_STATE_HOME", "MAW_SENDER", "MAW_FEDERATION_TOKEN", "MAW_PEER_KEY"} {
		t.Setenv(key, "")
	}
	t.Setenv("HOME", home)
	path := filepath.Join(home, "peers.json")
	t.Setenv("PEERS_FILE", path)
	return path
}
func TestFederationSignatures(t *testing.T) {
	h := federationHeaders(federationConfig{sender: "m5:mawjs", fleet: "0123456789abcdef-federation-token", key: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"}, time.Unix(1700000000, 0))
	if h.Get("X-Maw-From") != "mawjs:m5" || h.Get("X-Maw-Signature") != "75847c2f51d6c3191061fd28bfca49a377cf22d1f98042b92ac193d7f8106dc3" || h.Get("X-Maw-Signature-V3") != "c3d28ac7cc1c5fc124d5a7d0fd83a59777551d555e905480ab7e0516bd19bfd8" {
		t.Fatal(h)
	}
	if len(federationHeaders(federationConfig{}, time.Now())) != 0 {
		t.Fatal("unsigned prerequisites")
	}
}
func TestFederationStore(t *testing.T) {
	path := isolatedFederation(t)
	if c, e := readFederationConfig(true); e != nil || len(c.peers) != 0 {
		t.Fatal(c, e)
	}
	for _, raw := range []string{"", `{}`, `{"version":2,"peers":{}}`, `{"version":1,"peers":{"x":{"url":"http://user:secret@localhost"}}}`, `{"version":1,"peers":{"x":{"url":"http://localhost","authOk":"yes"}}}`, strings.Repeat("x", federationLimit+1)} {
		os.WriteFile(path, []byte(raw), 0600)
		if _, e := readFederationConfig(false); e == nil {
			t.Fatal("accepted invalid store")
		}
	}
	raw := `{"version":1,"peers":{"alias":{"url":"http://localhost:1234/prefix","node":"node","identity":{"oracle":"oracle"},"authOk":false}}}`
	os.WriteFile(path, []byte(raw), 0600)
	c, e := readFederationConfig(true)
	if e != nil || len(c.peers) != 1 || c.peers[0].Name != "alias" || c.peers[0].AuthOK == nil || *c.peers[0].AuthOK {
		t.Fatal(c, e)
	}
	os.Rename(path, path+".real")
	os.Symlink(path+".real", path)
	if _, e := readFederationConfig(false); e == nil {
		t.Fatal("symlink accepted")
	}
}
func TestFederationSafety(t *testing.T) {
	for _, raw := range []string{"file:///x", "http://x?", "http://x#", "http://x?q=y", "http://x:99999", "http://[fe80::1%25en0]", "http://x/\n"} {
		if _, e := federationURL(raw); e == nil {
			t.Fatal(raw)
		}
	}
	for _, ip := range []string{"0.0.0.0", "::", "169.254.169.254", "fe80::1", "224.0.0.1", "::1", "127.0.0.1"} {
		if federationIPAllowed(net.ParseIP(ip), "example.test") {
			t.Fatal(ip)
		}
	}
	if !federationIPAllowed(net.ParseIP("127.0.0.1"), "localhost") || !federationIPAllowed(net.ParseIP("192.168.1.2"), "private.test") {
		t.Fatal("legitimate IP rejected")
	}
}
func TestFederationProbe(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		body, error string
	}{{"success", 200, `[{"name":"agent"}]`, ""}, {"unauthorized", 401, `secret`, "http_401"}, {"redirect", 302, ``, "http_302"}, {"malformed", 200, `private invalid`, "invalid_sessions"}, {"wrong-shape", 200, `{}`, "invalid_sessions"}, {"limit", 200, strings.Repeat("x", federationLimit+1), "body_too_large"}} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/prefix/api/sessions" || r.Header.Get("Authorization") != "" {
					t.Error("request contract", r.URL, r.Header)
				}
				w.Header().Set("Location", "http://127.0.0.1:1/never")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			p := federationProbe(context.Background(), federationPeer{URL: server.URL + "/prefix"}, http.Header{})
			if !p.Reachable || !p.LoopbackSelf || p.Latency == nil || p.FetchError != tc.error {
				t.Fatal(p)
			}
			if tc.error == "" && (len(p.Agents) != 1 || p.Agents[0] != "agent") {
				t.Fatal(p)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	p := federationProbe(ctx, federationPeer{URL: server.URL}, http.Header{})
	if p.Reachable || p.FetchError != "timeout" {
		t.Fatal(p)
	}
}
func TestFederationCacheAndAPI(t *testing.T) {
	s, _ := testServer(t)
	path := isolatedFederation(t)
	var count atomic.Int32
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		time.Sleep(20 * time.Millisecond)
		w.Write([]byte(`[{"name":"one"}]`))
	}))
	defer peer.Close()
	raw, _ := json.Marshal(map[string]any{"version": 1, "peers": map[string]any{"alias": map[string]any{"url": peer.URL, "node": "one"}}})
	os.WriteFile(path, raw, 0600)
	c, e := readFederationConfig(true)
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, e := s.federationStatus(context.Background(), c)
			if e != nil || p.Reachable != 1 || !p.Peers[0].NodeUnique {
				t.Error(p, e)
			}
		}()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatal("not singleflight", count.Load())
	}
	for _, route := range []string{"/fed.json", "/api/federation/status", "/api/config"} {
		w := request(s, "GET", route, "", map[string]string{"Authorization": ""})
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
		w = request(s, "GET", route, "", map[string]string{"Authorization": "Bearer " + testToken})
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	c.fingerprint[0] ^= 1
	if _, e := s.federationStatus(context.Background(), c); e != nil || count.Load() != 2 {
		t.Fatal(e, count.Load())
	}
}

func TestFederationFourProbesAndWaiterCancellation(t *testing.T) {
	s, _ := testServer(t)
	isolatedFederation(t)
	var active, peak atomic.Int32
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
		w.Write([]byte(`[]`))
	}))
	defer peer.Close()
	c := federationConfig{fingerprint: [32]byte{1}}
	for range 12 {
		c.peers = append(c.peers, federationPeer{URL: peer.URL})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.federationStatus(ctx, c); err == nil {
		t.Fatal("cancelled waiter succeeded")
	}
	p, err := s.federationStatus(context.Background(), c)
	if err != nil || p.Reachable != 12 || peak.Load() > 4 || peak.Load() < 2 {
		t.Fatal(p, err, peak.Load())
	}
}

func TestFederationSessionNamesIgnoreNonStrings(t *testing.T) {
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[null,5,{"name":null},{"name":5},{"name":"yes"}]`))
	}))
	defer peer.Close()
	row := federationProbe(context.Background(), federationPeer{URL: peer.URL}, http.Header{})
	if row.FetchError != "" || len(row.Agents) != 1 || row.Agents[0] != "yes" {
		t.Fatal(row)
	}
}

func TestFederationLegacyStoreFallback(t *testing.T) {
	isolatedFederation(t)
	t.Setenv("PEERS_FILE", "")
	t.Setenv("MAW_STATE_DIR", t.TempDir())
	legacy := filepath.Join(os.Getenv("HOME"), ".maw")
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(legacy, "peers.json"), []byte(`{"version":1,"peers":{"legacy":{"url":"http://localhost"}}}`), 0600)
	c, err := readFederationConfig(false)
	if err != nil || len(c.peers) != 1 || c.peers[0].Name != "legacy" {
		t.Fatal(c, err)
	}
	t.Setenv("MAW_HOME", t.TempDir())
	c, err = readFederationConfig(false)
	if err != nil || len(c.peers) != 0 {
		t.Fatal("explicit MAW_HOME must not fall back", c, err)
	}
	t.Setenv("MAW_HOME", "")
	t.Setenv("PEERS_FILE", filepath.Join(t.TempDir(), "missing.json"))
	c, err = readFederationConfig(false)
	if err != nil || len(c.peers) != 0 {
		t.Fatal("explicit PEERS_FILE must not fall back", c, err)
	}
}
