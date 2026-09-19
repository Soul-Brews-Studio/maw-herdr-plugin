package main

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const backendSnapshot = `{"result":{"snapshot":{"protocol":22,"workspaces":[{"workspace_id":"wD","label":"demo"}],"panes":[{"pane_id":"wD:p4","workspace_id":"wD","agent":"codex","focused":true,"agent_status":"idle","cwd":"/tmp"},{"pane_id":"wD:p9","workspace_id":"wD","agent":null,"focused":false,"agent_status":"unknown"}]}}}`

func testBackend(t *testing.T) (*HerdrBackend, *[][]string, *string) {
	t.Helper()
	calls := [][]string{}
	snapshot := backendSnapshot
	b := NewHerdrBackend("")
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{}, args...))
		if reflect.DeepEqual(args, []string{"session", "list", "--json"}) {
			return []byte(`{"sessions":[{"name":"main","running":true},{"name":"stopped","running":false}]}`), nil
		}
		if reflect.DeepEqual(args, []string{"--session", "main", "api", "snapshot"}) {
			return []byte(snapshot), nil
		}
		if len(args) > 3 && args[2] == "pane" {
			return []byte("visible output\n"), nil
		}
		if len(args) > 3 && args[2] == "agent" {
			return []byte(`{"ok":true}`), nil
		}
		t.Fatalf("unexpected command: %q", args)
		return nil, nil
	}
	return b, &calls, &snapshot
}
func TestBackendRosterAndArgv(t *testing.T) {
	b, calls, _ := testBackend(t)
	sessions, err := b.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []Session{{Name: "bWFpbg/d0Q", Source: "local", Windows: []Window{{Index: 4, Name: "codex", Active: true, Cwd: "/tmp", Status: "idle"}, {Index: 9, Name: "wD:p9", Status: "unknown"}}}}
	if !reflect.DeepEqual(sessions, want) {
		t.Fatalf("got %#v", sessions)
	}
	target := sessions[0].Name + ":4"
	content, err := b.Capture(context.Background(), target, 80)
	if err != nil || content != "visible output\n" {
		t.Fatalf("capture %q %v", content, err)
	}
	if !reflect.DeepEqual((*calls)[len(*calls)-1], []string{"--session", "main", "pane", "read", "wD:p4", "--source", "visible", "--lines", "80", "--format", "text"}) {
		t.Fatal(*calls)
	}
	text := "hello; $(touch never)\nnext line"
	if err = b.Send(context.Background(), target, text); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual((*calls)[len(*calls)-1], []string{"--session", "main", "agent", "prompt", "wD:p4", text}) {
		t.Fatal(*calls)
	}
	if len(*calls) != 8 {
		t.Fatalf("each operation must refresh roster: %v", *calls)
	}
}
func TestBackendStaleAndShellTargets(t *testing.T) {
	b, calls, snapshot := testBackend(t)
	if err := b.Send(context.Background(), "bWFpbg/d0Q:9", "hello"); !errors.Is(err, ErrNotAgent) {
		t.Fatal(err)
	}
	*snapshot = strings.ReplaceAll(backendSnapshot, "wD:p4", "wD:p5")
	if _, err := b.Capture(context.Background(), "bWFpbg/d0Q:4", 80); !errors.Is(err, ErrTargetNotFound) {
		t.Fatal(err)
	}
	if len(*calls) != 4 {
		t.Fatal("unexpected capture/send side effect", *calls)
	}
}
func TestBackendMalformedSnapshots(t *testing.T) {
	for name, snapshot := range map[string]string{
		"empty": "{}", "null": "null", "error": `{"error":{"message":"no"}}`,
		"protocol":          strings.Replace(backendSnapshot, `"protocol":22`, `"protocol":23`, 1),
		"duplicate":         strings.Replace(backendSnapshot, "wD:p9", "wD:p4", 1),
		"leading zero":      strings.Replace(backendSnapshot, "wD:p4", "wD:p04", 1),
		"wrong workspace":   strings.Replace(backendSnapshot, "wD:p4", "other:p4", 1),
		"unknown workspace": strings.Replace(backendSnapshot, `"workspace_id":"wD","agent":"codex"`, `"workspace_id":"missing","agent":"codex"`, 1),
		"missing focused":   strings.Replace(backendSnapshot, `"focused":true,`, "", 1),
	} {
		t.Run(name, func(t *testing.T) {
			b, _, raw := testBackend(t)
			*raw = snapshot
			if _, err := b.Sessions(context.Background()); err == nil {
				t.Fatal("accepted malformed snapshot")
			}
		})
	}
}
func TestBackendSessionEnvelopeFailures(t *testing.T) {
	for _, raw := range []string{`{}`, `{"sessions":null}`, `{"sessions":[{"name":"x"}]}`, `{"sessions":[{"name":"x","running":false},{"name":"x","running":false}]}`, `{"error":"offline"}`, `[]`} {
		b := NewHerdrBackend("")
		b.run = func(context.Context, ...string) ([]byte, error) { return []byte(raw), nil }
		if _, err := b.Sessions(context.Background()); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	b := NewHerdrBackend("")
	b.run = func(context.Context, ...string) ([]byte, error) { return nil, errors.New("offline") }
	if _, err := b.Sessions(context.Background()); err == nil {
		t.Fatal("hid backend failure")
	}
	b.run = func(context.Context, ...string) ([]byte, error) { return []byte(`{"result":{"sessions":[]}}`), nil }
	sessions, err := b.Sessions(context.Background())
	if err != nil || sessions == nil || len(sessions) != 0 {
		t.Fatalf("empty roster: %#v %v", sessions, err)
	}
}
func TestBackendValidationBeforeCalls(t *testing.T) {
	b, calls, _ := testBackend(t)
	for _, lines := range []int{-1, 0, 2001} {
		if _, err := b.Capture(context.Background(), "x", lines); err == nil {
			t.Fatal(lines)
		}
	}
	for _, text := range []string{"", " ", "a\x00b", strings.Repeat("a", 65537)} {
		if err := b.Send(context.Background(), "x", text); err == nil {
			t.Fatal("accepted invalid text")
		}
	}
	if len(*calls) != 0 {
		t.Fatal("validation called backend")
	}
}
func TestBackendCommandLimits(t *testing.T) {
	out := &limitedOutput{limit: 3}
	if _, err := out.Write([]byte("four")); err == nil || out.Len() != 0 {
		t.Fatal("unbounded output")
	}
	b := NewHerdrBackend("/does/not/exist")
	if _, err := b.command(context.Background()); err == nil {
		t.Fatal("hid exec failure")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	if _, err := b.command(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
func TestBackendEnvelopeVariants(t *testing.T) {
	raw := []byte(backendSnapshot)
	body, err := unwrapBackend(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, snapshot := range []string{string(body), `{"snapshot":` + string(body) + `}`, `{"result":` + string(body) + `}`} {
		b, _, p := testBackend(t)
		*p = snapshot
		if _, err := b.Sessions(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBackendNamesAndIndicesAreStable(t *testing.T) {
	b := NewHerdrBackend("")
	reverse := false
	b.run = func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "session" {
			return []byte(`{"sessions":[{"name":"a/b:c","running":true},{"name":"a:b/c","running":true}]}`), nil
		}
		panes := `{"pane_id":"wD:p4","workspace_id":"wD","focused":false,"agent_status":"idle"},{"pane_id":"wD:p9","workspace_id":"wD","focused":false,"agent_status":"idle"}`
		if reverse {
			panes = `{"pane_id":"wD:p9","workspace_id":"wD","focused":false,"agent_status":"idle"},{"pane_id":"wD:p4","workspace_id":"wD","focused":false,"agent_status":"idle"}`
		}
		return []byte(`{"protocol":22,"workspaces":[{"workspace_id":"wD"}],"panes":[` + panes + `]}`), nil
	}
	a, err := b.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reverse = true
	c, err := b.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, c) || len(a) != 2 || a[0].Name == a[1].Name {
		t.Fatalf("unstable/colliding: %#v %#v", a, c)
	}
}

func TestBackendFailuresNeverBecomeEmptySuccess(t *testing.T) {
	for _, operation := range []string{"snapshot", "capture", "send"} {
		t.Run(operation, func(t *testing.T) {
			b, _, _ := testBackend(t)
			run := b.run
			b.run = func(ctx context.Context, args ...string) ([]byte, error) {
				if len(args) > 2 && ((operation == "snapshot" && args[2] == "api") || (operation == "capture" && args[2] == "pane") || (operation == "send" && args[2] == "agent")) {
					return nil, errors.New("unreadable backend")
				}
				return run(ctx, args...)
			}
			var err error
			switch operation {
			case "snapshot":
				_, err = b.Sessions(context.Background())
			case "capture":
				_, err = b.Capture(context.Background(), "bWFpbg/d0Q:4", 80)
			case "send":
				err = b.Send(context.Background(), "bWFpbg/d0Q:4", "hello")
			}
			if err == nil {
				t.Fatal("backend failure reported success")
			}
		})
	}
}
func TestBackendPromptFlagIsLiteralText(t *testing.T) {
	b, calls, _ := testBackend(t)
	if err := b.Send(context.Background(), "bWFpbg/d0Q:4", "--wait"); err != nil {
		t.Fatal(err)
	}
	// src/cli/agent.rs agent_prompt reads args[0]/args[1] before its option loop.
	want := []string{"--session", "main", "agent", "prompt", "wD:p4", "--wait"}
	if !reflect.DeepEqual((*calls)[len(*calls)-1], want) {
		t.Fatal(*calls)
	}
}

func TestBackendCaptureBatchSharesRoster(t *testing.T) {
	b, calls, _ := testBackend(t)
	got, err := b.CaptureBatch(context.Background(), map[string]int{"bWFpbg/d0Q:4": 80, "bWFpbg/d0Q:9": 15})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["bWFpbg/d0Q:4"] != "visible output\n" || got["bWFpbg/d0Q:9"] != "visible output\n" {
		t.Fatal(got)
	}
	// One session-list + one snapshot + two reads, not two full resolutions.
	if len(*calls) != 4 {
		t.Fatalf("calls=%v", *calls)
	}
	if (*calls)[2][4] != "wD:p4" || (*calls)[3][4] != "wD:p9" || (*calls)[3][8] != "15" {
		t.Fatal(*calls)
	}
}
func TestBackendCaptureBatchPreflight(t *testing.T) {
	b, calls, _ := testBackend(t)
	tooMany := map[string]int{}
	for i := 0; i < 65; i++ {
		tooMany[strconv.Itoa(i)] = 80
	}
	for _, targets := range []map[string]int{tooMany, {"bWFpbg/d0Q:4": 80, "bad": 0}, {"bad": 2001}} {
		if _, err := b.CaptureBatch(context.Background(), targets); err == nil {
			t.Fatal("accepted invalid batch")
		}
	}
	if len(*calls) != 0 {
		t.Fatal("validation invoked subprocess", *calls)
	}
	got, err := b.CaptureBatch(context.Background(), map[string]int{"bWFpbg/d0Q:4": 80, "unknown": 80})
	if !errors.Is(err, ErrTargetNotFound) || got != nil {
		t.Fatalf("got=%v err=%v", got, err)
	}
	if len(*calls) != 2 {
		t.Fatal("unknown target allowed pane read", *calls)
	}
	got, err = b.CaptureBatch(context.Background(), nil)
	if err != nil || got == nil || len(got) != 0 || len(*calls) != 2 {
		t.Fatal("empty batch should not run backend")
	}
}
func TestBackendCaptureBatchFailureIsAtomic(t *testing.T) {
	b, calls, _ := testBackend(t)
	run := b.run
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) > 4 && args[2] == "pane" && args[4] == "wD:p9" {
			return nil, errors.New("pane disappeared")
		}
		return run(ctx, args...)
	}
	got, err := b.CaptureBatch(context.Background(), map[string]int{"bWFpbg/d0Q:4": 80, "bWFpbg/d0Q:9": 80})
	if err == nil || got != nil || len(*calls) != 3 {
		t.Fatalf("partial success: %v %v %v", got, err, *calls)
	}
}
func TestBackendCaptureBatchDeadline(t *testing.T) {
	b, _, _ := testBackend(t)
	run := b.run
	var deadline time.Time
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		d, ok := ctx.Deadline()
		if !ok || time.Until(d) > 10*time.Second {
			t.Fatal("missing bounded deadline")
		}
		if deadline.IsZero() {
			deadline = d
		}
		if !d.Equal(deadline) {
			t.Fatal("operation deadline extended")
		}
		if len(args) > 2 && args[2] == "pane" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return run(ctx, args...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	got, err := b.CaptureBatch(ctx, map[string]int{"bWFpbg/d0Q:4": 80, "bWFpbg/d0Q:9": 80})
	if !errors.Is(err, context.DeadlineExceeded) || got != nil {
		t.Fatalf("got=%v err=%v", got, err)
	}
}
