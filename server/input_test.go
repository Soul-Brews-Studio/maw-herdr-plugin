package main

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type inputFake struct {
	fakeBackend
	inputMu sync.Mutex
	texts   []string
	enters  []bool
}

func (b *inputFake) Input(_ context.Context, target, text string, enter bool) error {
	b.inputMu.Lock()
	defer b.inputMu.Unlock()
	b.texts = append(b.texts, text)
	b.enters = append(b.enters, enter)
	return nil
}
func TestWSInlineSendSelectionAliasAndEnter(t *testing.T) {
	b := &inputFake{}
	f := newWSFixture(t, b, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	readWS(t, conn)
	for _, command := range []map[string]any{{"type": "send", "content": "  "}, {"type": "send", "text": "\r"}, {"type": "send", "text": "", "content": "ignored", "force": true}} {
		sendWS(t, conn, command)
		frame := readWS(t, conn)
		if frame["type"] != "sent" || frame["target"] != "default/w1:1" {
			t.Fatal(frame)
		}
	}
	b.inputMu.Lock()
	defer b.inputMu.Unlock()
	if !reflect.DeepEqual(b.texts, []string{"  ", "\r", ""}) || !reflect.DeepEqual(b.enters, []bool{false, false, true}) {
		t.Fatal(b.texts, b.enters)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sends != 0 {
		t.Fatal("agent prompt invoked")
	}
}
func TestInlineBackendArgvAndValidation(t *testing.T) {
	b, calls, _ := testBackend(t)
	if err := b.Input(context.Background(), "bWFpbg/d0Q:9", "  literal;$(x)\r", true); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"--session", "main", "pane", "send-text", "wD:p9", "  literal;$(x)\r"}, {"--session", "main", "pane", "send-keys", "wD:p9", "enter"}}
	if !reflect.DeepEqual((*calls)[2:], want) {
		t.Fatal(*calls)
	}
	for _, text := range []string{"", "--help", "\r"} {
		before := len(*calls)
		if err := b.Input(context.Background(), "bWFpbg/d0Q:9", text, false); err != nil {
			t.Fatal(err)
		}
		expected := []string{"--session", "main", "pane", "send-text", "wD:p9", text}
		if len(*calls) != before+3 || !reflect.DeepEqual((*calls)[len(*calls)-1], expected) {
			t.Fatal("literal input argv", *calls)
		}
	}
	for _, text := range []string{"\x00", strings.Repeat("a", 65537)} {
		before := len(*calls)
		if err := b.Input(context.Background(), "bWFpbg/d0Q:9", text, false); err == nil || len(*calls) != before {
			t.Fatal("invalid input reached backend")
		}
	}
	if err := b.Input(context.Background(), "gone", "", false); err != ErrTargetNotFound {
		t.Fatal(err)
	}
}

func TestWSInlineRejectsExplicitEmptyTargetAndNullText(t *testing.T) {
	b := &inputFake{}
	f := newWSFixture(t, b, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	readWS(t, conn)
	for _, command := range []map[string]any{
		{"type": "send", "target": "", "text": "do not execute", "force": true},
		{"type": "send", "text": nil, "content": "do not execute", "force": true},
	} {
		sendWS(t, conn, command)
		if frame := readWS(t, conn); frame["type"] != "error" {
			t.Fatal("invalid send accepted", frame)
		}
	}
	b.inputMu.Lock()
	defer b.inputMu.Unlock()
	if len(b.texts) != 0 {
		t.Fatal("invalid input forwarded", b.texts)
	}
}
