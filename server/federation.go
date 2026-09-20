package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

var errFederation = errors.New("federation_unavailable")

const federationLimit = 1 << 20

type federationPeer struct {
	Name     string
	URL      string  `json:"url"`
	Node     *string `json:"node"`
	Identity *struct {
		Oracle *string `json:"oracle"`
	} `json:"identity"`
	AuthOK *bool `json:"authOk"`
}
type federationConfig struct {
	peers              []federationPeer
	sender, fleet, key string
	fingerprint        [32]byte
}
type federationStatus struct {
	URL          string   `json:"url"`
	Node         *string  `json:"node"`
	Reachable    bool     `json:"reachable"`
	Latency      *int64   `json:"latency"`
	Agents       []string `json:"agents"`
	ClockWarning bool     `json:"clock_warning"`
	Oracle       *string  `json:"oracle"`
	ResolvedIP   *string  `json:"resolved_ip"`
	NodeUnique   bool     `json:"node_unique"`
	AuthOK       *bool    `json:"auth_ok"`
	FetchError   string   `json:"fetch_error,omitempty"`
	LoopbackSelf bool     `json:"loopback_self"`
}
type federationPayload struct {
	LocalURL  string             `json:"local_url"`
	Peers     []federationStatus `json:"peers"`
	Total     int                `json:"totalPeers"`
	Reachable int                `json:"reachablePeers"`
}
type federationCache struct {
	mu          sync.Mutex
	flight      chan struct{}
	fingerprint [32]byte
	at          time.Time
	payload     federationPayload
}

// Local configuration is read-only. Reject static symlinks at every component;
// same-user concurrent replacement of ancestor directories is not a trust boundary.
func federationRead(path string, limit int64) ([]byte, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, errFederation
	}
	missing := false
	for current := path; ; current = filepath.Dir(current) {
		st, e := os.Lstat(current)
		if os.IsNotExist(e) {
			missing = true
			if filepath.Dir(current) == current {
				break
			}
			continue
		}
		if e != nil || st.Mode()&os.ModeSymlink != 0 {
			return nil, errFederation
		}
		if current != path && !st.IsDir() {
			return nil, errFederation
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	if missing {
		return nil, nil
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, errFederation
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errFederation
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errFederation
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || !os.SameFile(before, st) {
		return nil, errFederation
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) > limit || !utf8.Valid(b) {
		return nil, errFederation
	}
	return b, nil
}
func federationState() string {
	if p := os.Getenv("MAW_HOME"); p != "" {
		return p
	}
	if p := os.Getenv("MAW_STATE_DIR"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	switch strings.ToLower(os.Getenv("MAW_XDG")) {
	case "1", "true", "yes", "on":
		p := os.Getenv("XDG_STATE_HOME")
		if p == "" {
			p = filepath.Join(home, ".local", "state")
		}
		return filepath.Join(p, "maw")
	}
	return filepath.Join(home, ".maw")
}
func federationURL(raw string) (*url.URL, error) {
	for _, r := range raw {
		if r <= 32 || r == 127 {
			return nil, errFederation
		}
	}
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || strings.Contains(u.Hostname(), "%") {
		return nil, errFederation
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, errFederation
		}
	}
	return u, nil
}
func readFederationConfig(signing bool) (federationConfig, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return federationConfig{}, errConfig
	}
	return readFederationConfigAt(signing, cwd)
}
func readFederationConfigAt(signing bool, cwd string) (federationConfig, error) {
	c := federationConfig{peers: []federationPeer{}}
	path := os.Getenv("PEERS_FILE")
	if path == "" {
		path = filepath.Join(federationState(), "peers.json")
	}
	raw, err := federationRead(path, federationLimit)
	if err != nil {
		return c, err
	}
	if raw == nil && os.Getenv("PEERS_FILE") == "" && os.Getenv("MAW_HOME") == "" {
		home, e := os.UserHomeDir()
		if e != nil {
			return c, errFederation
		}
		legacy := filepath.Join(home, ".maw", "peers.json")
		if filepath.Clean(path) != filepath.Clean(legacy) {
			path = legacy
			raw, err = federationRead(path, federationLimit)
			if err != nil {
				return c, err
			}
		}
	}
	if raw != nil {
		var store struct {
			Version int                        `json:"version"`
			Peers   map[string]json.RawMessage `json:"peers"`
		}
		if json.Unmarshal(raw, &store) != nil || store.Version != 1 || store.Peers == nil || len(store.Peers) > 32 {
			return c, errFederation
		}
		for name, b := range store.Peers {
			var p federationPeer
			if string(b) == "null" || json.Unmarshal(b, &p) != nil {
				return c, errFederation
			}
			if _, err := federationURL(p.URL); err != nil {
				return c, err
			}
			p.Name = name
			c.peers = append(c.peers, p)
		}
		sort.Slice(c.peers, func(i, j int) bool { return c.peers[i].Name < c.peers[j].Name })
	}
	if signing {
		merged, e := loadMergedConfig(cwd)
		if e != nil {
			return c, e
		}
		c.sender = os.Getenv("MAW_SENDER")
		if _, present := os.LookupEnv("MAW_SENDER"); !present {
			node, nok := merged["node"].(string)
			oracle, ook := merged["oracle"].(string)
			if nok && ook {
				c.sender = node + ":" + strings.TrimSpace(oracle)
			}
		}
		c.fleet = strings.TrimSpace(os.Getenv("MAW_FEDERATION_TOKEN"))
		if c.fleet == "" {
			if token, ok := merged["federationToken"].(string); ok {
				c.fleet = strings.TrimSpace(token)
			}
		}
		c.key = os.Getenv("MAW_PEER_KEY")
		if c.key == "" {
			b, e := federationRead(filepath.Join(federationState(), "peer-key"), 4096)
			if e != nil {
				return c, e
			}
			c.key = strings.TrimSpace(string(b))
		}
	}
	fingerprint, _ := json.Marshal([]string{path, string(raw), c.sender, c.fleet, c.key})
	c.fingerprint = sha256.Sum256(fingerprint)
	return c, nil
}
func federationHeaders(c federationConfig, now time.Time) http.Header {
	h := http.Header{}
	parts := strings.Split(c.sender, ":")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || c.fleet == "" || c.key == "" {
		return h
	}
	for _, r := range c.sender {
		if r <= 32 || r == 127 {
			return h
		}
	}
	from := parts[1] + ":" + parts[0]
	ts := strconv.FormatInt(now.Unix(), 10)
	base := "GET:/api/sessions:" + ts
	sign := func(key, msg string) string {
		m := hmac.New(sha256.New, []byte(key))
		m.Write([]byte(msg))
		return hex.EncodeToString(m.Sum(nil))
	}
	h.Set("X-Maw-From", from)
	h.Set("X-Maw-Timestamp", ts)
	h.Set("X-Maw-Auth-Version", "v3")
	h.Set("X-Maw-Signature", sign(c.fleet, base))
	h.Set("X-Maw-Signature-V3", sign(c.key, base+"::"+from))
	return h
}
func federationIPAllowed(ip net.IP, host string) bool {
	if v4 := ip.To4(); v4 != nil && (v4[0] == 0 || v4[0] >= 224) {
		return false
	}
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return !ip.IsLoopback() || strings.EqualFold(host, "localhost") || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}
func federationProbe(ctx context.Context, p federationPeer, headers http.Header) federationStatus {
	out := federationStatus{URL: p.URL, Node: p.Node, AuthOK: p.AuthOK, Agents: []string{}}
	if p.Identity != nil && p.Identity.Oracle != nil && *p.Identity.Oracle != "" {
		out.Oracle = p.Identity.Oracle
	}
	ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	started := time.Now()
	u, err := federationURL(p.URL)
	if err != nil {
		out.FetchError = "invalid_url"
		return out
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", u.Hostname())
	if err != nil || len(ips) == 0 {
		out.FetchError = "dns_failed"
		return out
	}
	for _, ip := range ips {
		if !federationIPAllowed(ip, u.Hostname()) {
			out.FetchError = "address_not_allowed"
			return out
		}
	}
	ip := ips[0]
	ipString := ip.String()
	out.ResolvedIP = &ipString
	out.LoopbackSelf = ip.IsLoopback()
	if addrs, e := net.InterfaceAddrs(); e == nil {
		for _, a := range addrs {
			if n, _, e := net.ParseCIDR(a.String()); e == nil && n.Equal(ip) {
				out.LoopbackSelf = true
			}
		}
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/sessions"
	u.RawPath = ""
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 64 << 10, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ipString, port))
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	req.Header = headers.Clone()
	resp, err := client.Do(req)
	if err != nil {
		out.FetchError = "request_failed"
		if ctx.Err() != nil {
			out.FetchError = "timeout"
		}
		return out
	}
	defer resp.Body.Close()
	out.Reachable = true
	elapsed := time.Since(started).Milliseconds()
	out.Latency = &elapsed
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		out.FetchError = fmt.Sprintf("http_%d", resp.StatusCode)
		return out
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, federationLimit+1))
	if err != nil {
		out.FetchError = "body_failed"
		return out
	}
	if len(b) > federationLimit {
		out.FetchError = "body_too_large"
		return out
	}
	var sessions []json.RawMessage
	if json.Unmarshal(b, &sessions) != nil || sessions == nil {
		out.FetchError = "invalid_sessions"
		return out
	}
	for _, item := range sessions {
		var session map[string]json.RawMessage
		if json.Unmarshal(item, &session) != nil || session == nil {
			continue
		}
		var name *string
		if json.Unmarshal(session["name"], &name) == nil && name != nil {
			out.Agents = append(out.Agents, *name)
		}
	}
	return out
}
func (s *Server) federationStatus(ctx context.Context, c federationConfig) (federationPayload, error) {
	for {
		s.federation.mu.Lock()
		if s.federation.fingerprint == c.fingerprint && !s.federation.at.IsZero() && time.Since(s.federation.at) < 15*time.Second {
			p := s.federation.payload
			s.federation.mu.Unlock()
			return p, nil
		}
		if s.federation.flight == nil {
			done := make(chan struct{})
			s.federation.flight = done
			go func() {
				sweep, cancel := context.WithTimeout(s.context, 10*time.Second)
				defer cancel()
				p := federationPayload{Peers: make([]federationStatus, len(c.peers)), Total: len(c.peers)}
				headers := federationHeaders(c, time.Now())
				slots := make(chan struct{}, 4)
				var wg sync.WaitGroup
				for i, peer := range c.peers {
					wg.Add(1)
					go func(i int, peer federationPeer) {
						defer wg.Done()
						select {
						case slots <- struct{}{}:
							defer func() { <-slots }()
						case <-sweep.Done():
							p.Peers[i] = federationStatus{URL: peer.URL, Node: peer.Node, AuthOK: peer.AuthOK, Agents: []string{}, FetchError: "timeout"}
							if peer.Identity != nil {
								p.Peers[i].Oracle = peer.Identity.Oracle
							}
							return
						}
						p.Peers[i] = federationProbe(sweep, peer, headers)
					}(i, peer)
				}
				wg.Wait()
				counts := map[string]int{}
				for _, peer := range c.peers {
					if peer.Node != nil && *peer.Node != "" {
						counts[*peer.Node]++
					}
				}
				for i := range p.Peers {
					v := &p.Peers[i]
					v.NodeUnique = v.Node != nil && *v.Node != "" && counts[*v.Node] == 1
					if v.Reachable {
						p.Reachable++
					}
				}
				s.federation.mu.Lock()
				s.federation.payload = p
				s.federation.fingerprint = c.fingerprint
				s.federation.at = time.Now()
				s.federation.flight = nil
				close(done)
				s.federation.mu.Unlock()
			}()
		}
		done := s.federation.flight
		s.federation.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return federationPayload{}, errFederation
		case <-s.context.Done():
			return federationPayload{}, errFederation
		}
	}
}
