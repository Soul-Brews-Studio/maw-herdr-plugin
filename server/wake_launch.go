package main

import (
	"errors"
	"sort"
	"strings"
	"unicode"
)

var errWakeLaunch = errors.New("wake launch unavailable")

type wakeLaunch struct {
	SelectedKey string   `json:"selectedKey"`
	Line        string   `json:"line"`
	Family      string   `json:"family"`
	Warnings    []string `json:"warnings"`
}

// renderWakeLaunch preserves trusted local shell programs; it does not execute
// or parse them as argv. Family detection deliberately matches legacy heuristics.
func renderWakeLaunch(config map[string]any, window string, explicit *string, fallback string) (wakeLaunch, error) {
	result := wakeLaunch{Warnings: []string{}}
	commands, _ := config["commands"].(map[string]any)
	wake, _ := config["wake"].(map[string]any)
	text := func(obj map[string]any, key string) string { v, _ := obj[key].(string); return strings.TrimSpace(v) }
	keys := make([]string, 0, len(commands))
	for key := range commands {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	selected, line := "", ""
	choose := func(key string) bool {
		if command := text(commands, key); command != "" {
			selected, line = key, command
			return true
		}
		return false
	}
	if explicit != nil {
		choose(*explicit)
	}
	if line == "" {
		choose(window)
	}
	stem := strings.TrimSpace(window)
	if len(stem) > 7 && strings.EqualFold(stem[len(stem)-7:], "-oracle") {
		stem = strings.TrimSpace(stem[:len(stem)-7])
	}
	stem = strings.ToLower(stem)
	if line == "" && stem != "" {
		for _, candidate := range []string{stem + "-oracle", stem} {
			if candidate == window {
				continue
			}
			if choose(candidate) {
				break
			}
			for _, key := range keys {
				if wakeASCIIEqual(key, candidate) && choose(key) {
					break
				}
			}
			if line != "" {
				break
			}
		}
	}
	if line == "" {
		for _, key := range keys {
			if key == "default" || key == window {
				continue
			}
			match := strings.HasPrefix(key, "*") && strings.HasSuffix(window, key[1:]) || strings.HasSuffix(key, "*") && strings.HasPrefix(window, key[:len(key)-1])
			if match && choose(key) {
				break
			}
		}
	}
	if line == "" && explicit != nil {
		selected, line = *explicit, *explicit
	}
	if line == "" {
		engine := text(wake, "engine")
		if engine == "" {
			engine = text(config, "defaultEngine")
		}
		if engine != "" && !choose(engine) {
			selected, line = engine, engine
		}
	}
	if line == "" {
		choose("default")
	}
	if line == "" {
		if fallback == "" {
			fallback = "codex"
		}
		if !choose(fallback) {
			selected, line = fallback, fallback
		}
	}
	resume, _ := wake["resume"].(bool)
	channels, _ := wake["channels"].(bool)
	if resume {
		if override := text(commands, selected+"-resume"); override != "" {
			line = wakePoolPrefix(config, override)
		} else {
			line = wakePoolPrefix(config, line)
			start, end := wakeBinarySpan(line)
			family := wakeBinaryFamily(line)
			switch family {
			case "claude":
				line += " --continue"
			case "codex", "omx":
				if start >= 0 {
					line = line[:end] + " resume" + line[end:]
				} else {
					line += " resume"
				}
			default:
				line += " resume"
				result.Warnings = append(result.Warnings, "unknown_resume_form")
			}
		}
	} else {
		line = wakePoolPrefix(config, line)
	}
	if channels {
		override := text(commands, selected+"-channels")
		if !resume && override != "" {
			line = wakePoolPrefix(config, override)
		} else if wakeBinaryFamily(line) == "claude" {
			line += " --channels plugin:discord@claude-plugins-official"
		} else {
			result.Warnings = append(result.Warnings, "channels_not_claude")
		}
	}
	if prompt := text(wake, "prompt"); prompt != "" {
		separator := ""
		if wakeBinaryFamily(line) == "claude" {
			words := strings.Fields(line)
			has := false
			for _, word := range words {
				if word == "--channels" || strings.HasPrefix(word, "--channels=") {
					has = true
				}
			}
			if has && len(words) > 0 && words[len(words)-1] != "--" {
				separator = " --"
			}
		}
		line += separator + " " + wakeShellQuote(prompt)
	}
	result.SelectedKey = selected
	result.Family = wakeBinaryFamily(line)
	result.Line = "MAW_SESSION_WINDOW=" + wakeShellQuote(window) + " " + line
	if len(result.Line) > 64<<10 || strings.ContainsRune(result.Line, 0) {
		return wakeLaunch{}, errWakeLaunch
	}
	return result, nil
}
func wakeASCIIEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range len(a) {
		x, y := a[i], b[i]
		if x >= 'A' && x <= 'Z' {
			x += 32
		}
		if y >= 'A' && y <= 'Z' {
			y += 32
		}
		if x != y {
			return false
		}
	}
	return true
}
func wakeShellQuote(value string) string {
	safe := true
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("/._-:=", c)) {
			safe = false
			break
		}
	}
	if safe {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
func wakePoolPrefix(config map[string]any, line string) string {
	group, _ := config["zaiPool"].(string)
	if group == "" || strings.HasPrefix(line, "MAW_ZAI_POOL=") {
		return line
	}
	for _, c := range group {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return line
		}
	}
	return "MAW_ZAI_POOL=" + group + " " + line
}
func wakeBinarySpan(line string) (int, int) {
	start := 0
	for start < len(line) {
		tail := strings.TrimLeftFunc(line[start:], unicode.IsSpace)
		start = len(line) - len(tail)
		if start == len(line) {
			break
		}
		end := strings.IndexFunc(line[start:], unicode.IsSpace)
		if end < 0 {
			end = len(line)
		} else {
			end += start
		}
		word := line[start:end]
		name, _, assignment := strings.Cut(word, "=")
		if assignment {
			if name == "" || name[0] >= '0' && name[0] <= '9' {
				assignment = false
			}
			for _, c := range name {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
					assignment = false
				}
			}
		}
		if !assignment && word != "command" {
			return start, end
		}
		start = end
	}
	return -1, -1
}
func wakeBinaryFamily(line string) string {
	start, end := wakeBinarySpan(line)
	if start < 0 {
		return ""
	}
	word := line[start:end]
	if i := strings.LastIndexByte(word, '/'); i >= 0 {
		word = word[i+1:]
	}
	return word
}
