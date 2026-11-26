// Package format is the pure shaping of what the tools return, kept apart from I/O so it can be
// tested on its own.
package format

import (
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

// ISOTime writes a time in Unix milliseconds the way the tools give times: 2026-11-26T09:30:00.000Z.
func ISOTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// prefix returns the first units UTF-16 units of text, and whether text is longer than that. The
// TypeScript service measured text in UTF-16 units, so limits keep meaning what they meant. A
// character that would be cut in half is left out.
func prefix(text string, units int) (string, bool) {
	for index, char := range text {
		units -= utf16.RuneLen(char)
		if units < 0 {
			return text[:index], true
		}
	}
	return text, false
}

// suffix returns the last units UTF-16 units of text, leaving out a character that would be cut in
// half.
func suffix(text string, units int) string {
	start := len(text)
	for start > 0 {
		char, size := utf8.DecodeLastRuneInString(text[:start])
		units -= utf16.RuneLen(char)
		if units < 0 {
			break
		}
		start -= size
	}
	return text[start:]
}

// given says whether a JSON value counts as present, the way a JavaScript condition reads it: null,
// false, 0 and "" don't.
func given(value any) bool {
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case float64:
		return value != 0
	case string:
		return value != ""
	}
	return true
}

// AttachmentRef describes one attachment of a message.
type AttachmentRef struct {
	Index       int     `json:"index"`
	Kind        string  `json:"kind"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"content_type"`
	Size        *int64  `json:"size"`
	Encrypted   bool    `json:"encrypted"`
	// MXC is the media URI. For an encrypted file it identifies the ciphertext only: download through
	// the tool.
	MXC *string `json:"mxc"`
}

// Reaction is one reaction to a message, with everyone who gave it.
type Reaction struct {
	Key     string   `json:"key"`
	Count   int      `json:"count"`
	Senders []string `json:"senders"`
}

// FormattedMessage is a message as the tools return it. Its fields are in the order the TypeScript
// service wrote them.
type FormattedMessage struct {
	EventID       string          `json:"event_id"`
	RoomID        string          `json:"room_id"`
	Sender        string          `json:"sender"`
	IsMe          bool            `json:"is_me"`
	Timestamp     *string         `json:"timestamp"`
	TS            *int64          `json:"ts"`
	Type          string          `json:"type"`
	Text          string          `json:"text"`
	Edited        bool            `json:"edited"`
	Encrypted     bool            `json:"encrypted"`
	Attachments   []AttachmentRef `json:"attachments"`
	SenderName    string          `json:"sender_name,omitempty"`
	TextTruncated bool            `json:"text_truncated,omitempty"`
	HTML          string          `json:"html,omitempty"`
	ReplyTo       string          `json:"reply_to,omitempty"`
	ThreadRoot    string          `json:"thread_root,omitempty"`
	Reactions     []Reaction      `json:"reactions,omitempty"`
}

// AttachmentRefs describes a message's attachments, in their order.
func AttachmentRefs(attachments []msg.Attachment) []AttachmentRef {
	refs := make([]AttachmentRef, 0, len(attachments))
	for index, attachment := range attachments {
		ref := AttachmentRef{
			Index:       index,
			Kind:        attachment.Kind,
			Filename:    attachment.Filename,
			ContentType: attachment.ContentType,
			Size:        attachment.Size,
			Encrypted:   attachment.EncryptedFile != nil,
			MXC:         attachment.ContentURI,
		}
		if attachment.EncryptedFile != nil {
			ref.MXC = &attachment.EncryptedFile.URL
		}
		refs = append(refs, ref)
	}
	return refs
}

// Options says how to format a message.
type Options struct {
	// MaxText is the most text to return, in UTF-16 units; longer text is cut and marked.
	MaxText int
	// SenderName is the sender's display name, when it is known.
	SenderName string
	// IncludeHTML adds the formatted body, cut to MaxText.
	IncludeHTML bool
}

// FormatMessage shapes a message for a tool's answer.
func FormatMessage(message msg.Message, options Options) FormattedMessage {
	text, truncated := prefix(message.Text, options.MaxText)
	if truncated {
		text += "…"
	}
	out := FormattedMessage{
		EventID:       message.EventID,
		RoomID:        message.RoomID,
		Sender:        message.Sender.UserID,
		IsMe:          message.Sender.IsMe,
		Type:          message.MessageType,
		Text:          text,
		Edited:        message.Edited,
		Encrypted:     message.Encrypted,
		Attachments:   AttachmentRefs(message.Attachments),
		SenderName:    options.SenderName,
		TextTruncated: truncated,
		ReplyTo:       message.ReplyTo,
		ThreadRoot:    message.ThreadRoot,
	}
	if message.Timestamp != nil {
		ts, timestamp := *message.Timestamp, ISOTime(*message.Timestamp)
		out.TS, out.Timestamp = &ts, &timestamp
	}
	if options.IncludeHTML && message.HTML != nil {
		out.HTML, _ = prefix(*message.HTML, options.MaxText)
	}
	return out
}

// RawEvent is an event of a history page as the homeserver gave it, before decryption. A missing
// event ID, type, sender or timestamp is its zero value; StateKey is nil for anything but a state
// event.
type RawEvent struct {
	EventID        string         `json:"event_id,omitempty"`
	Type           string         `json:"type,omitempty"`
	Sender         string         `json:"sender,omitempty"`
	OriginServerTS int64          `json:"origin_server_ts,omitempty"`
	StateKey       *string        `json:"state_key,omitempty"`
	Content        map[string]any `json:"content,omitempty"`
	Unsigned       map[string]any `json:"unsigned,omitempty"`
}

// OmitReason is why an event of a page isn't among the messages returned.
type OmitReason string

const (
	ReasonUndecryptable OmitReason = "undecryptable"
	ReasonNotAMessage   OmitReason = "not_a_message"
	ReasonThreadReply   OmitReason = "thread_reply"
	ReasonUnsupported   OmitReason = "unsupported"
)

// OmittedEvent is an event of a page that isn't among the messages returned.
type OmittedEvent struct {
	EventID   string     `json:"event_id"`
	Type      string     `json:"type"`
	Sender    *string    `json:"sender"`
	Timestamp *string    `json:"timestamp"`
	Reason    OmitReason `json:"reason"`
	Error     string     `json:"error,omitempty"`
}

// PageAccounting says what became of every raw event of a history page.
type PageAccounting struct {
	Undecryptable []OmittedEvent `json:"undecryptable"`
	ThreadReplies []OmittedEvent `json:"thread_replies"`
	Other         []OmittedEvent `json:"other"`
	EditsMerged   int            `json:"edits_merged"`
	Reactions     int            `json:"reactions"`
	Redacted      int            `json:"redacted"`
	StateEvents   int            `json:"state_events"`
	RawEvents     int            `json:"raw_events"`
}

// relation is an event's m.relates_to: its type, the event it points at and, for a reaction, the key.
func relation(event RawEvent) (relType, eventID, key string) {
	related, _ := event.Content["m.relates_to"].(map[string]any)
	relType, _ = related["rel_type"].(string)
	eventID, _ = related["event_id"].(string)
	key, _ = related["key"].(string)
	return relType, eventID, key
}

func omitted(event RawEvent, reason OmitReason, failure string) OmittedEvent {
	out := OmittedEvent{EventID: event.EventID, Type: event.Type, Reason: reason, Error: failure}
	if event.Sender != "" {
		out.Sender = &event.Sender
	}
	if event.OriginServerTS != 0 {
		timestamp := ISOTime(event.OriginServerTS)
		out.Timestamp = &timestamp
	}
	return out
}

// AccountPage accounts for every raw event of a history page against the messages that were
// returned, so nothing silently vanishes: events that couldn't be decrypted are listed with the
// error that was reported. returnedIDs holds the event IDs of the returned messages; decryptErrors
// maps an event ID to its decryption error.
func AccountPage(rawEvents []RawEvent, returnedIDs map[string]bool, decryptErrors map[string]string) PageAccounting {
	page := PageAccounting{
		Undecryptable: []OmittedEvent{},
		ThreadReplies: []OmittedEvent{},
		Other:         []OmittedEvent{},
		RawEvents:     len(rawEvents),
	}
	for _, event := range rawEvents {
		if returnedIDs[event.EventID] {
			continue
		}
		if event.StateKey != nil {
			page.StateEvents++
			continue
		}
		if given(event.Unsigned["redacted_because"]) || (event.Type == "m.room.encrypted" && len(event.Content) == 0) {
			page.Redacted++
			continue
		}
		relType, _, _ := relation(event)
		if event.Type == "m.reaction" || relType == "m.annotation" {
			page.Reactions++
			continue
		}
		if relType == "m.replace" {
			page.EditsMerged++
			continue
		}
		if relType == "m.thread" {
			page.ThreadReplies = append(page.ThreadReplies, omitted(event, ReasonThreadReply, ""))
			continue
		}
		failure := decryptErrors[event.EventID]
		switch {
		case event.Type == "m.room.encrypted" && failure != "":
			page.Undecryptable = append(page.Undecryptable, omitted(event, ReasonUndecryptable, failure))
		case event.Type == "m.room.message":
			page.Other = append(page.Other, omitted(event, ReasonUnsupported, ""))
		default:
			page.Other = append(page.Other, omitted(event, ReasonNotAMessage, ""))
		}
	}
	return page
}

// ReactionsByTarget groups the unencrypted reactions in a page onto the messages they react to: for
// each message's event ID, its reactions in the order they first appear, each with its senders in
// that order.
func ReactionsByTarget(rawEvents []RawEvent) map[string][]Reaction {
	out := map[string][]Reaction{}
	for _, event := range rawEvents {
		relType, target, key := relation(event)
		if event.Type != "m.reaction" || relType != "m.annotation" || target == "" || key == "" {
			continue
		}
		reactions := out[target]
		at := slices.IndexFunc(reactions, func(reaction Reaction) bool { return reaction.Key == key })
		if at < 0 {
			at = len(reactions)
			reactions = append(reactions, Reaction{Key: key})
			out[target] = reactions
		}
		if !slices.Contains(reactions[at].Senders, event.Sender) {
			reactions[at].Senders = append(reactions[at].Senders, event.Sender)
			reactions[at].Count++
		}
	}
	return out
}

// trim removes the leading and trailing whitespace JavaScript's trim does. strings.TrimSpace differs
// in two characters (it drops U+0085 and keeps U+FEFF), and a download keeps the filename it had
// under the TypeScript service.
func trim(text string) string {
	return strings.TrimFunc(text, func(char rune) bool {
		switch char {
		case '\t', '\n', '\v', '\f', '\r', 0x2028, 0x2029, 0xFEFF:
			return true
		}
		return unicode.Is(unicode.Zs, char)
	})
}

var underscores = regexp.MustCompile(`_{2,}`)

// SafeFilename makes a filename safe for one path segment, keeping the extension readable. An empty
// name, or one with nothing left, gives fallback.
func SafeFilename(name, fallback string) string {
	base := name[strings.LastIndexAny(name, `\/`)+1:]
	replaced := strings.Map(func(char rune) rune {
		if char < 0x20 || strings.ContainsRune(`<>:"|?*`, char) {
			return '_'
		}
		return char
	}, base)
	cleaned := suffix(trim(strings.TrimLeft(underscores.ReplaceAllString(replaced, "_"), ".")), 120)
	if cleaned == "" {
		return fallback
	}
	return cleaned
}

var extensionTypes = map[string]string{
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
	"webp": "image/webp",
	"heic": "image/heic",
	"mp4":  "video/mp4",
	"mov":  "video/quicktime",
	"webm": "video/webm",
	"mp3":  "audio/mpeg",
	"m4a":  "audio/mp4",
	"ogg":  "audio/ogg",
	"wav":  "audio/wav",
	"pdf":  "application/pdf",
	"txt":  "text/plain",
	"md":   "text/markdown",
	"csv":  "text/csv",
	"json": "application/json",
	"zip":  "application/zip",
	"doc":  "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

// ContentTypeFor is the content type a filename's extension stands for, or application/octet-stream.
func ContentTypeFor(filename string) string {
	lower := strings.ToLower(filename)
	if contentType, known := extensionTypes[lower[strings.LastIndex(lower, ".")+1:]]; known {
		return contentType
	}
	return "application/octet-stream"
}

// MediaKind is how a file of a content type is sent: "image", "video", "audio" or "file". sendAs is
// "auto", or "file" to send anything as a plain file.
func MediaKind(contentType, sendAs string) string {
	if sendAs == "file" {
		return "file"
	}
	for _, kind := range []string{"image", "video", "audio"} {
		if strings.HasPrefix(contentType, kind+"/") {
			return kind
		}
	}
	return "file"
}

var credentialName = regexp.MustCompile(`(?i)(token|secret|credential|password|passwd|private[-_]?key|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|config\.ya?ml|auth\.json|\.env)`)

// RefusedUploadReason says why send_file refuses a path, when it does, so a steered agent can't mail
// out Hermes's own credentials: hidden files and directories (.env, .ssh, .config), this service's
// state, and names that look like secrets. realPath and stateDir are resolved paths.
func RefusedUploadReason(realPath, stateDir string) (reason string, refused bool) {
	if realPath == stateDir || strings.HasPrefix(realPath, stateDir+"/") {
		return "it is inside beeper-inbox's private state", true
	}
	segments := slices.DeleteFunc(strings.Split(realPath, "/"), func(segment string) bool { return segment == "" })
	if slices.ContainsFunc(segments, func(segment string) bool { return strings.HasPrefix(segment, ".") }) {
		return "hidden files and folders (such as .env or .ssh) can't be sent", true
	}
	if len(segments) > 0 && credentialName.MatchString(segments[len(segments)-1]) {
		return "the filename looks like a credential or configuration file", true
	}
	if slices.Contains(segments, "mcp-tokens") {
		return "it is inside Hermes's MCP token store", true
	}
	return "", false
}
