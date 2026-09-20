package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestWakeLaunchSharedCases(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("source path unavailable")
	}
	raw, e := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "utils", "wake-launch-cases.json"))
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Name     string         `json:"name"`
		Config   map[string]any `json:"config"`
		Window   string         `json:"window"`
		Explicit *string        `json:"explicitEngine"`
		Fallback string         `json:"fallback"`
		Expected wakeLaunch     `json:"expected"`
		Error    string         `json:"error"`
	}
	if e := json.Unmarshal(raw, &cases); e != nil {
		t.Fatal(e)
	}
	if len(cases) < 25 {
		t.Fatal("missing contract fixtures")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, e := renderWakeLaunch(tc.Config, tc.Window, tc.Explicit, tc.Fallback)
			if tc.Error != "" {
				if e == nil || e.Error() != tc.Error {
					t.Fatal("expected generic error", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(got, tc.Expected) {
				t.Fatalf("renderer mismatch\ngot %#v\nwant %#v", got, tc.Expected)
			}
		})
	}
}
func TestWakeLaunchBoundsAndWarningPrivacy(t *testing.T) {
	for _, value := range []string{strings.Repeat("x", 64<<10), "private\x00secret"} {
		_, e := renderWakeLaunch(map[string]any{"commands": map[string]any{"neo": value}}, "neo", nil, "")
		if e == nil || e.Error() != "wake launch unavailable" {
			t.Fatal("unsafe output", e)
		}
	}
	got, e := renderWakeLaunch(map[string]any{"commands": map[string]any{"neo": "TOKEN=private-secret custom"}, "wake": map[string]any{"resume": true, "channels": true}}, "neo", nil, "")
	if e != nil {
		t.Fatal(e)
	}
	for _, warning := range got.Warnings {
		if strings.Contains(warning, "secret") || strings.Contains(warning, "custom") {
			t.Fatal("warning leaked command")
		}
	}
}
