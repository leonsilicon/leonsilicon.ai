package inbox

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

var roomIDPattern = regexp.MustCompile(`^![^\s/]{3,255}$`)

func stringArg(args map[string]any, key string) (string, bool) {
	value, ok := args[key].(string)
	return value, ok
}

// numberArg reads a number the way the tools always have: anything that isn't a usable number (or
// is zero) falls back.
func numberArg(args map[string]any, key string, fallback int) int {
	switch value := args[key].(type) {
	case float64:
		if value != 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			return int(value)
		}
	case int:
		if value != 0 {
			return value
		}
	case int64:
		if value != 0 {
			return int(value)
		}
	}
	return fallback
}

func clamp(value, low, high int) int {
	return max(low, min(value, high))
}

func cut(text string, max int) string {
	runes := []rune(text)
	if len(runes) > max {
		return string(runes[:max])
	}
	return text
}

func roomIDOf(value any) (string, error) {
	raw, ok := value.(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", toolError("bad_argument", "room_id is required")
	}
	roomID := strings.TrimSpace(raw)
	// Opaque: "!abc:beeper.local", "!abc:beeper.com", and room v12 IDs with no server part ("!<hash>").
	if !roomIDPattern.MatchString(roomID) {
		return "", toolError("bad_argument", fmt.Sprintf(
			"\"%s\" is not a Matrix room ID (they start with \"!\", like !abc123:beeper.local). Use list_conversations to find one; the chat IDs in the Slack #feed- posts are room IDs.",
			cut(roomID, 80)))
	}
	return roomID, nil
}

func eventIDOf(value any, field string) (string, error) {
	raw, ok := value.(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", toolError("bad_argument", field+" is required")
	}
	eventID := strings.TrimSpace(raw)
	if !strings.HasPrefix(eventID, "$") {
		return "", toolError("bad_argument", fmt.Sprintf(
			"%s \"%s\" is not a Matrix event ID (they start with $). A Slack ts like 1793918187.574419 is not one; get event IDs from list_messages.",
			field, cut(eventID, 80)))
	}
	return eventID, nil
}
