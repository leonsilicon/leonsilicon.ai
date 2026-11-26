package grokrelay

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
)

// The relay was written in TypeScript, and its limits, cursors and state files follow JavaScript's
// rules: lengths count UTF-16 units, times are ISO strings with milliseconds, and numbers in tool
// arguments are converted the way Number() does. These helpers keep the Go relay on the same rules,
// so the text it sends and the files it reads and writes stay the same.

// jsSpaces is JavaScript's \s as a character class, for regular expressions carried over from it.
const jsSpaces = `[\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]`

// utf16Len is a string's length as JavaScript counts it.
func utf16Len(text string) int {
	units := 0
	for _, r := range text {
		units++
		if r > 0xFFFF {
			units++
		}
	}
	return units
}

// utf16Prefix is text.slice(0, max). A character that the cut would split in two is left out.
func utf16Prefix(text string, max int) string {
	units := 0
	for index, r := range text {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > max {
			return text[:index]
		}
		units += size
	}
	return text
}

// isoTime is new Date(ms).toISOString().
func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseTime is Date.parse for the ISO strings the relay and the inbox write: Unix milliseconds, or
// NaN for anything else. NaN compares false with everything, as it does in JavaScript, so a
// timestamp nobody can read never counts as fresh.
func parseTime(text string) float64 {
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return math.NaN()
	}
	return float64(parsed.UnixMilli())
}

// jsRound is Math.round, which rounds halves up.
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

// formatNumber writes a number the way a JavaScript template does: no trailing zeros, "NaN" for NaN.
func formatNumber(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if value == 0 {
		return "0"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// jsNumber is Number(value) for what a JSON tool argument can hold.
func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return math.NaN()
		}
		return parsed
	case string:
		trimmed := handoff.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	}
	return math.NaN()
}

// sortKeyOf orders a chat's messages by time, with the event ID breaking ties, and compares as a
// plain string: timestamps keep 13 digits until the year 2286.
func sortKeyOf(ts int64, eventID string) string {
	digits := strconv.FormatInt(ts, 10)
	if len(digits) < 13 {
		digits = strings.Repeat("0", 13-len(digits)) + digits
	}
	return digits + ":" + eventID
}

// newUUID is a random (version 4) UUID, as crypto.randomUUID() gives.
func newUUID() string {
	var raw [16]byte
	// crypto/rand.Read never fails on the platforms the daemon runs on.
	_, _ = rand.Read(raw[:])
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	text := hex.EncodeToString(raw[:])
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:32]
}

// chunks splits text into parts of at most size characters (code points, like Array.from).
func chunks(text string, size int) []string {
	var parts []string
	for len(text) > 0 {
		end := 0
		for count := 0; count < size && end < len(text); count++ {
			_, width := utf8.DecodeRuneInString(text[end:])
			end += width
		}
		parts = append(parts, text[:end])
		text = text[end:]
	}
	return parts
}
