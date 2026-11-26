package feeds

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// maxText is how much of a message the feed keeps, shows the screener and posts.
const maxText = 3_800

// unnamedRoom stands in for the name of a room that has none.
const unnamedRoom = "Beeper conversation"

var slackEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// escapeSlack neutralizes Slack control sequences such as <!channel> or <@U123> in text written by
// contacts.
func escapeSlack(text string) string {
	return slackEscaper.Replace(text)
}

var reasonLabels = map[string]string{
	"ok":                         "ok",
	"prompt_injection":           "tries to instruct an AI",
	"credential_or_code_request": "asks for a password, code or access",
	"phishing_or_malicious_link": "phishing or a suspicious link",
	"scam_or_fraud":              "scam or fraud",
	"impersonation":              "impersonation",
	"threat_or_harassment":       "threat or harassment",
	"promotion":                  "promotion",
	"bulk_or_automated":          "bulk or automated",
	"other":                      "other",
	"screener_unavailable":       "the screener couldn't check it, so it's held to be safe",
	"screener_refused":           "the screener refused to judge it",
}

func reasonLabel(reason string) string {
	if label, known := reasonLabels[reason]; known {
		return label
	}
	return reason
}

// A cut can land inside an escape such as &amp; and leave a piece of it behind.
var brokenEscape = regexp.MustCompile(`(?i)&[a-z]*$`)

// excerpt escapes value for Slack and keeps it within limit characters, ending in … when cut.
func excerpt(value string, limit int) string {
	escaped := escapeSlack(cut(value, limit))
	if units(escaped) <= limit && units(value) <= limit {
		return escaped
	}
	return brokenEscape.ReplaceAllString(cut(escaped, limit-1), "") + "…"
}

func roomName(room host.RoomInfo) string {
	if room.Name == nil {
		return unnamedRoom
	}
	return *room.Name
}

// mirrorText is the Slack copy of a message: who wrote it and where, the text as a quote, and the
// room and event IDs that find the original in Beeper.
func mirrorText(message host.JournalEntry, room host.RoomInfo, sender string, decided verdict) string {
	label := ""
	if decided.Route != routeSafe {
		kind := "Flagged"
		if decided.Route == routeSpam {
			kind = "Spam"
		}
		label = "[" + kind + " · " + reasonLabel(decided.Reason) + "] "
	}
	title := excerpt(oneLine(roomName(room)), 160)
	name := excerpt(oneLine(sender), 120)
	origin := excerpt(room.Network, 40)
	header := label + title + " · " + origin + " · " + name
	ids := "Chat `" + excerpt(strings.ReplaceAll(message.RoomID, "`", "'"), 220) +
		"` · message `" + excerpt(strings.ReplaceAll(message.EventID, "`", "'"), 220) + "`"
	attachments := ""
	if message.Attachments > 0 {
		attachments = "\n" + strconv.Itoa(message.Attachments) + " attachment(s) in Beeper"
	}
	body := trim(message.Text)
	if body == "" {
		body = "[No text]"
		if message.Attachments != 0 {
			body = "[Attachment]"
		}
	}
	space := maxText - units(header) - units(ids) - units(attachments) - 10
	return header + "\n>>> " + excerpt(body, space) + attachments + "\n" + ids
}
