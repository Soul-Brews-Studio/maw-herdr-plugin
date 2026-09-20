package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var errTeamInventory = errors.New("team inventory unavailable")

const teamFileLimit = 1 << 20

type teamReader struct {
	home                          string
	bytes, tasks, members, output int
}

// Fixed local paths only. Validate every component, then match the opened
// non-following descriptor to the inspected inode before reading any bytes.
func (r *teamReader) open(parts []string, directory bool) (*os.File, error) {
	path := r.home
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errTeamInventory
	}
	for i, part := range parts {
		if part == "" || part == "." || part == ".." || filepath.Base(part) != part {
			return nil, errTeamInventory
		}
		path = filepath.Join(path, part)
		info, err = os.Lstat(path)
		if err != nil {
			return nil, err
		}
		wantDir := i < len(parts)-1 || directory
		if info.Mode()&os.ModeSymlink != 0 || (wantDir && !info.IsDir()) || (!wantDir && !info.Mode().IsRegular()) {
			return nil, errTeamInventory
		}
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		file.Close()
		return nil, errTeamInventory
	}
	return file, nil
}
func (r *teamReader) entries(parts ...string) ([]os.DirEntry, error) {
	file, err := r.open(parts, true)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	limit := 1001
	if len(parts) == 2 && parts[1] == "teams" {
		limit = 100
	}
	entries, err := file.ReadDir(limit + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > limit {
		return nil, errTeamInventory
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}
func (r *teamReader) object(parts ...string) (map[string]any, error) {
	file, err := r.open(parts, false)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > teamFileLimit || info.Size() < 0 {
		return nil, errTeamInventory
	}
	data, err := io.ReadAll(io.LimitReader(file, teamFileLimit+1))
	if err != nil {
		return nil, err
	}
	r.bytes += len(data)
	if len(data) > teamFileLimit || r.bytes > 4<<20 {
		return nil, errTeamInventory
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var object map[string]any
	if decoder.Decode(&object) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, nil
	}
	return object, nil
}

// Account each normalized leaf before retaining it. A shared large leadRepo
// repeated across many members must fail before constructing a huge response.
func (r *teamReader) reserve(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return errTeamInventory
	}
	r.output += len(data) + 1
	if r.output > 4<<20 {
		return errTeamInventory
	}
	return nil
}

func teamString(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}
func teamNumber(value any) int64 {
	number, ok := value.(json.Number)
	if !ok {
		return 0
	}
	n, err := strconv.ParseInt(string(number), 10, 64)
	if err != nil || n < 0 || n > 9007199254740991 {
		return 0
	}
	return n
}
func teamStrings(value any) []string {
	result := []string{}
	array, _ := value.([]any)
	for _, value := range array {
		if text, ok := value.(string); ok {
			result = append(result, text)
		}
	}
	return result
}
func localTeamMember(member map[string]any, home string, now int64) bool {
	cwd := teamString(member, "cwd")
	if !filepath.IsAbs(cwd) {
		return false
	}
	relative, err := filepath.Rel(home, filepath.Clean(cwd))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	joined, _ := member["joinedAt"].(int64)
	age := now - joined
	if age < 0 {
		age = 0
	}
	backend := teamString(member, "backendType")
	return age < 2*60*60*1000 && (backend == "in-process" || teamString(member, "name") == "team-lead" || teamString(member, "agentType") == "team-lead")
}
func (r *teamReader) membersFor(config map[string]any, name string, created int64) ([]map[string]any, error) {
	result := []map[string]any{}
	members, _ := config["members"].([]any)
	for _, raw := range members {
		r.members++
		if r.members > 1000 {
			return nil, errTeamInventory
		}
		member, _ := raw.(map[string]any)
		out := map[string]any{}
		for _, key := range []string{"model", "repo", "color", "tmuxPaneId"} {
			out[key] = teamString(member, key)
		}
		memberName := teamString(member, "name")
		id := teamString(member, "agentId")
		if memberName == "" {
			if before, _, ok := strings.Cut(id, "@"); ok {
				memberName = before
			} else {
				memberName = "member"
			}
		}
		if id == "" {
			id = memberName + "@" + name
		}
		kind := teamString(member, "agentType")
		if kind == "" {
			kind = "member"
			if id == "team-lead@"+name || memberName == "team-lead" || memberName == "lead" {
				kind = "lead"
			}
		}
		joined := created
		if number, ok := member["joinedAt"].(json.Number); ok {
			if n, err := strconv.ParseInt(string(number), 10, 64); err == nil && n >= 0 && n <= 9007199254740991 {
				joined = n
			}
		}
		cwd := teamString(member, "cwd")
		if cwd == "" {
			cwd = teamString(member, "repo")
		}
		if cwd == "" {
			cwd = teamString(config, "leadRepo")
		}
		backend, ok := member["backendType"].(string)
		if !ok {
			backend = "in-process"
		}
		out["name"], out["agentId"], out["agentType"], out["joinedAt"] = memberName, id, kind, joined
		out["cwd"], out["backendType"], out["subscriptions"] = cwd, backend, teamStrings(member["subscriptions"])
		if err := r.reserve(out); err != nil {
			return nil, err
		}
		result = append(result, out)
	}
	return result, nil
}
func (r *teamReader) tasksFor(name string) ([]map[string]any, error) {
	result := []map[string]any{}
	entries, err := r.entries(".claude", "tasks", name)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		r.tasks++
		if r.tasks > 1000 {
			return nil, errTeamInventory
		}
		object, err := r.object(".claude", "tasks", name, entry.Name())
		if err != nil {
			return nil, err
		}
		if object == nil {
			continue
		}
		out := map[string]any{}
		for _, key := range []string{"id", "subject", "description", "status", "owner", "activeForm"} {
			if value, ok := object[key].(string); ok {
				out[key] = value
			}
		}
		if number, ok := object["id"].(json.Number); ok {
			if id, err := strconv.ParseInt(string(number), 10, 64); err == nil && id >= -9007199254740991 && id <= 9007199254740991 {
				out["id"] = id
			}
		}
		for _, key := range []string{"blockedBy", "blocks"} {
			if _, ok := object[key].([]any); ok {
				out[key] = teamStrings(object[key])
			}
		}
		if err := r.reserve(out); err != nil {
			return nil, err
		}
		result = append(result, out)
	}
	return result, nil
}
func readTeams(home string, now time.Time) ([]map[string]any, error) {
	result := []map[string]any{}
	if !filepath.IsAbs(home) {
		return nil, errTeamInventory
	}
	reader := teamReader{home: filepath.Clean(home)}
	entries, err := reader.entries(".claude", "teams")
	if err != nil {
		return nil, err
	}
	count := 0
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return nil, errTeamInventory
		}
		if !entry.IsDir() {
			continue
		}
		count++
		if count > 100 {
			return nil, errTeamInventory
		}
		config, err := reader.object(".claude", "teams", entry.Name(), "config.json")
		if err != nil {
			return nil, err
		}
		if config == nil {
			continue
		}
		name := teamString(config, "name")
		if name == "" {
			name = entry.Name()
		}
		created := teamNumber(config["createdAt"])
		members, err := reader.membersFor(config, name, created)
		if err != nil {
			return nil, err
		}
		tasks, err := reader.tasksFor(entry.Name())
		if err != nil {
			return nil, err
		}
		alive := false
		for _, member := range members {
			if localTeamMember(member, reader.home, now.UnixMilli()) {
				alive = true
			}
		}
		team := map[string]any{"name": name, "createdAt": created, "leadAgentId": "team-lead@" + name, "members": members, "tasks": tasks, "alive": alive}
		for _, key := range []string{"description", "leadRepo", "leadSessionId"} {
			team[key] = teamString(config, key)
		}
		header := map[string]any{}
		for key, value := range team {
			if key != "members" && key != "tasks" {
				header[key] = value
			}
		}
		if err := reader.reserve(header); err != nil {
			return nil, err
		}
		result = append(result, team)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i]["name"].(string) < result[j]["name"].(string) })
	encoded, err := json.Marshal(map[string]any{"teams": result, "total": len(result)})
	if err != nil || len(encoded)+1 > 4<<20 {
		return nil, errTeamInventory
	}
	return result, nil
}
