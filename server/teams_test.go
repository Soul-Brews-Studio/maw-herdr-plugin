package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func teamFile(t *testing.T, home, path, body string) {
	t.Helper()
	full := filepath.Join(home, path)
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestTeamInventoryNormalizationWhitelistAndTasks(t *testing.T) {
	home := t.TempDir()
	now := time.Unix(1700000000, 0)
	config := fmt.Sprintf(`{"name":"alpha","createdAt":%d,"leadRepo":%q,"secret":"do-not-leak","members":[{"name":"team-lead","private":"do-not-leak"},{"name":"worker","backendType":"tmux","tmuxPaneId":"%%1"}]}`, now.UnixMilli(), home)
	teamFile(t, home, ".claude/teams/folder/config.json", config)
	teamFile(t, home, ".claude/tasks/folder/2.json", `{"id":"2","subject":"later","metadata":{"secret":"do-not-leak"},"blocks":["3",99]}`)
	teamFile(t, home, ".claude/tasks/folder/1.json", `{"id":"1","subject":"first","status":"completed"}`)
	teamFile(t, home, ".claude/tasks/folder/bad.json", `{`)
	teamFile(t, home, ".claude/tasks/folder/array.json", `[]`)
	teams, err := readTeams(home, now)
	if err != nil || len(teams) != 1 {
		t.Fatal(teams, err)
	}
	team := teams[0]
	members := team["members"].([]map[string]any)
	tasks := team["tasks"].([]map[string]any)
	if team["alive"] != true || team["leadAgentId"] != "team-lead@alpha" || members[0]["cwd"] != home || members[0]["joinedAt"] != now.UnixMilli() || members[0]["backendType"] != "in-process" {
		t.Fatal(team)
	}
	if len(tasks) != 2 || tasks[0]["id"] != "1" || tasks[1]["id"] != "2" {
		t.Fatal(tasks)
	}
	raw, _ := json.Marshal(teams)
	if strings.Contains(string(raw), "do-not-leak") {
		t.Fatal("unknown field leaked")
	}
	teams, err = readTeams(home, now.Add(2*time.Hour))
	if err != nil || teams[0]["alive"] != false {
		t.Fatal("expired/tmux team alive", teams, err)
	}
}
func TestTeamInventoryMissingMalformedAndContainment(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	if teams, err := readTeams(home, now); err != nil || len(teams) != 0 {
		t.Fatal(teams, err)
	}
	teamFile(t, home, ".claude/teams/bad/config.json", `{`)
	teamFile(t, home, ".claude/teams/traversal/config.json", fmt.Sprintf(`{"name":"../../outside","createdAt":%d,"members":[{"name":"worker","cwd":%q}]}`, now.UnixMilli(), home+"-other"))
	teams, err := readTeams(home, now)
	if err != nil || len(teams) != 1 || teams[0]["alive"] != false {
		t.Fatal(teams, err)
	}
	for _, cwd := range []string{home + "-other", filepath.Join(home, "..", "outside"), "relative"} {
		if localTeamMember(map[string]any{"cwd": cwd, "joinedAt": now.UnixMilli(), "backendType": "in-process"}, home, now.UnixMilli()) {
			t.Fatal("outside HOME alive", cwd)
		}
	}
}
func TestTeamInventoryRefusesSymlinksAndOversize(t *testing.T) {
	for _, part := range []string{".claude", ".claude/teams", ".claude/teams/team", ".claude/teams/team/config.json", ".claude/tasks/team", ".claude/tasks/team/1.json"} {
		t.Run(part, func(t *testing.T) {
			home := t.TempDir()
			outside := t.TempDir()
			teamFile(t, home, ".claude/teams/team/config.json", `{}`)
			target := filepath.Join(home, part)
			os.RemoveAll(target)
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				t.Fatal(err)
			}
			if strings.HasSuffix(part, ".json") {
				outside = filepath.Join(outside, "secret.json")
				os.WriteFile(outside, []byte(`{}`), 0600)
			}
			if err := os.Symlink(outside, target); err != nil {
				t.Fatal(err)
			}
			if _, err := readTeams(home, time.Now()); err == nil {
				t.Fatal("symlink accepted")
			}
		})
	}
	home := t.TempDir()
	teamFile(t, home, ".claude/teams/team/config.json", strings.Repeat("x", teamFileLimit+1))
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("oversize accepted")
	}
}
func TestTeamInventoryLimitsAndHTTPFailure(t *testing.T) {
	home := t.TempDir()
	for i := 0; i < 101; i++ {
		teamFile(t, home, fmt.Sprintf(".claude/teams/%03d/config.json", i), `{}`)
	}
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("team limit ignored")
	}
	t.Setenv("HOME", home)
	s, b := testServer(t)
	if w := request(s, "GET", "/api/teams", "", nil); w.Code != 503 || !strings.Contains(w.Body.String(), "teams_unavailable") {
		t.Fatal(w.Code, w.Body)
	}
	b.failure = true
	if w := request(s, "GET", "/api/teams", "", nil); w.Code != 503 || strings.Contains(w.Body.String(), "private") {
		t.Fatal(w.Code, w.Body)
	}
}

func TestTeamInventoryAggregateTaskAndMemberBounds(t *testing.T) {
	home := t.TempDir()
	teamFile(t, home, ".claude/teams/one/config.json", `{}`)
	teamFile(t, home, ".claude/teams/two/config.json", `{}`)
	for i := 0; i < 1001; i++ {
		team := "one"
		if i >= 500 {
			team = "two"
		}
		teamFile(t, home, fmt.Sprintf(".claude/tasks/%s/%04d.json", team, i), `{}`)
	}
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("aggregate task limit ignored")
	}
	home = t.TempDir()
	members := strings.Repeat(`{},`, 500) + `{}`
	for _, name := range []string{"one", "two"} {
		teamFile(t, home, ".claude/teams/"+name+"/config.json", `{"members":[`+members+`]}`)
	}
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("aggregate member limit ignored")
	}
	home = t.TempDir()
	payload := `{"description":"` + strings.Repeat("x", 900000) + `"}`
	for i := 0; i < 5; i++ {
		teamFile(t, home, fmt.Sprintf(".claude/teams/%d/config.json", i), payload)
	}
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("aggregate byte limit ignored")
	}
}
func TestTeamInventoryRejectsFIFOAndRequiresAuth(t *testing.T) {
	home := t.TempDir()
	teamFile(t, home, ".claude/teams/team/config.json", `{}`)
	path := filepath.Join(home, ".claude/teams/team/config.json")
	os.Remove(path)
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("FIFO accepted")
	}
	t.Setenv("HOME", home)
	s, _ := testServer(t)
	r := httptest.NewRequest("GET", "http://localhost/api/teams", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("unauthenticated inventory", w.Code)
	}
}
func TestTeamInventoryResponseAmplificationBound(t *testing.T) {
	home := t.TempDir()
	members := strings.TrimSuffix(strings.Repeat(`{},`, 1000), ",")
	teamFile(t, home, ".claude/teams/team/config.json", `{"leadRepo":"`+strings.Repeat("x", 5000)+`","members":[`+members+`]}`)
	if _, err := readTeams(home, time.Now()); err == nil {
		t.Fatal("normalization output bound ignored")
	}
}

func TestTeamsDeliveredOnAuthenticatedWebSocket(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{}, time.Hour)
	home := os.Getenv("HOME")
	teamFile(t, home, ".claude/teams/fixture/config.json", `{"name":"fixture","members":[]}`)
	conn := f.connect(t)
	for _, kind := range []string{"sessions", "recent"} {
		if frame := readWS(t, conn); frame["type"] != kind {
			t.Fatal(frame)
		}
	}
	frame := readWS(t, conn)
	if frame["type"] != "teams" {
		t.Fatal(frame)
	}
	teams := frame["teams"].([]any)
	if len(teams) != 1 || teams[0].(map[string]any)["name"] != "fixture" || teams[0].(map[string]any)["alive"] != false {
		t.Fatal(frame)
	}
	if w := request(f.server, "GET", "/api/teams", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"total":1`) || strings.Contains(w.Body.String(), "supported") {
		t.Fatal(w.Code, w.Body)
	}
}
func TestTeamsWebSocketReportsFilesystemFailure(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{}, time.Hour)
	home := os.Getenv("HOME")
	if err := os.Symlink(t.TempDir(), filepath.Join(home, ".claude")); err != nil {
		t.Fatal(err)
	}
	conn := f.connect(t)
	for _, kind := range []string{"sessions", "recent"} {
		if frame := readWS(t, conn); frame["type"] != kind {
			t.Fatal(frame)
		}
	}
	frame := readWS(t, conn)
	if frame["type"] != "error" || frame["error"] != "teams_unavailable" {
		t.Fatal("failure looked empty", frame)
	}
}

func TestTeamsPreserveSafeNumericTaskIDs(t *testing.T) {
	home := t.TempDir()
	teamFile(t, home, ".claude/teams/team/config.json", `{}`)
	for i, value := range []string{`1`, `"2"`, `9007199254740992`, `1.5`} {
		teamFile(t, home, fmt.Sprintf(".claude/tasks/team/%d.json", i), `{"id":`+value+`}`)
	}
	teams, err := readTeams(home, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tasks := teams[0]["tasks"].([]map[string]any)
	if tasks[0]["id"] != int64(1) || tasks[1]["id"] != "2" {
		t.Fatal(tasks)
	}
	if _, ok := tasks[2]["id"]; ok {
		t.Fatal("unsafe integer retained")
	}
	if _, ok := tasks[3]["id"]; ok {
		t.Fatal("fractional ID retained")
	}
}

func TestTeamInventoryIncrementalNormalizedBudget(t *testing.T) {
	home := t.TempDir()
	members := strings.TrimSuffix(strings.Repeat(`{},`, 500), ",")
	teamFile(t, home, ".claude/teams/team/config.json", `{"leadRepo":"`+strings.Repeat("x", 900000)+`","members":[`+members+`]}`)
	reader := teamReader{home: home}
	config, err := reader.object(".claude", "teams", "team", "config.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reader.membersFor(config, "team", 0); err == nil {
		t.Fatal("large inherited field accepted")
	}
	if reader.members > 5 {
		t.Fatal("normalized amplification allocated too many members", reader.members)
	}
}
