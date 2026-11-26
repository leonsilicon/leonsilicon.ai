package format

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

func equal(t *testing.T, got, want any, message string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %s, want %s", message, show(got), show(want))
	}
}

// show is a value as JSON.stringify writes it: the tools' answers go out without HTML escapes.
func show(value any) string {
	var out strings.Builder
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err.Error()
	}
	return strings.TrimSuffix(out.String(), "\n")
}

func ptr[T any](value T) *T { return &value }

func parse[T any](t *testing.T, text string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestPageAccountingListsUndecryptableEventsAndExplainsEveryOmission(t *testing.T) {
	raw := parse[[]RawEvent](t, `[
    { "event_id": "$ok", "type": "m.room.encrypted", "content": { "ciphertext": "x" } },
    { "event_id": "$bad", "type": "m.room.encrypted", "sender": "@a:x", "origin_server_ts": 1, "content": { "ciphertext": "y" } },
    { "event_id": "$thread", "type": "m.room.encrypted", "content": { "ciphertext": "z", "m.relates_to": { "rel_type": "m.thread", "event_id": "$root" } } },
    { "event_id": "$edit", "type": "m.room.encrypted", "content": { "ciphertext": "z", "m.relates_to": { "rel_type": "m.replace", "event_id": "$ok" } } },
    { "event_id": "$react", "type": "m.reaction", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$ok", "key": "👍" } } },
    { "event_id": "$member", "type": "m.room.member", "state_key": "@a:x", "content": {} },
    { "event_id": "$gone", "type": "m.room.message", "content": {}, "unsigned": { "redacted_because": {} } },
    { "event_id": "$status", "type": "m.room.encrypted", "content": { "ciphertext": "q" } }
  ]`)
	page := AccountPage(raw, map[string]bool{"$ok": true}, map[string]string{"$bad": "no session"})
	equal(t, page.Undecryptable, []OmittedEvent{{
		EventID: "$bad", Type: "m.room.encrypted", Sender: ptr("@a:x"), Timestamp: ptr("1970-01-01T00:00:00.001Z"),
		Reason: ReasonUndecryptable, Error: "no session",
	}}, "undecryptable events, with the error")
	equal(t, len(page.ThreadReplies), 1, "thread replies")
	equal(t, page.EditsMerged, 1, "edits")
	equal(t, page.Reactions, 1, "reactions")
	equal(t, page.StateEvents, 1, "state events")
	equal(t, page.Redacted, 1, "deleted messages")
	equal(t, page.Other, []OmittedEvent{{EventID: "$status", Type: "m.room.encrypted", Reason: ReasonNotAMessage}}, "everything else")
	equal(t, page.RawEvents, 8, "raw events")
}

func TestEveryKindOfOmission(t *testing.T) {
	raw := parse[[]RawEvent](t, `[
    { "event_id": "$emptied", "type": "m.room.encrypted", "content": {} },
    { "event_id": "$noContent", "type": "m.room.encrypted" },
    { "event_id": "$encryptedReaction", "type": "m.room.encrypted", "content": { "ciphertext": "x", "m.relates_to": { "rel_type": "m.annotation", "event_id": "$a" } } },
    { "event_id": "$location", "type": "m.room.message", "sender": "@a:x", "content": { "msgtype": "m.location" } },
    { "event_id": "$call", "type": "m.call.invite", "content": { "m.relates_to": "not an object" } },
    { "event_id": "$name", "type": "m.room.name", "state_key": "", "content": { "name": "x" } },
    { "event_id": "$kept", "type": "m.room.message", "unsigned": { "redacted_because": null } }
  ]`)
	page := AccountPage(raw, nil, map[string]string{"$emptied": "no session", "$location": "not used"})
	equal(t, page, PageAccounting{
		Undecryptable: []OmittedEvent{},
		ThreadReplies: []OmittedEvent{},
		Other: []OmittedEvent{
			{EventID: "$location", Type: "m.room.message", Sender: ptr("@a:x"), Reason: ReasonUnsupported},
			{EventID: "$call", Type: "m.call.invite", Reason: ReasonNotAMessage},
			{EventID: "$kept", Type: "m.room.message", Reason: ReasonUnsupported},
		},
		Reactions:   1,
		Redacted:    2,
		StateEvents: 1,
		RawEvents:   7,
	}, "what became of each event")
	equal(t, show(AccountPage(nil, nil, nil)),
		`{"undecryptable":[],"thread_replies":[],"other":[],"edits_merged":0,"reactions":0,"redacted":0,"state_events":0,"raw_events":0}`,
		"an empty page, as the tools return it")
}

func TestReactionsByTarget(t *testing.T) {
	raw := parse[[]RawEvent](t, `[
    { "type": "m.reaction", "sender": "@a:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$1", "key": "👍" } } },
    { "type": "m.reaction", "sender": "@b:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$1", "key": "❤️" } } },
    { "type": "m.reaction", "sender": "@b:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$1", "key": "👍" } } },
    { "type": "m.reaction", "sender": "@b:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$1", "key": "👍" } } },
    { "type": "m.reaction", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$2", "key": "ok" } } },
    { "type": "m.reaction", "sender": "@c:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$3" } } },
    { "type": "m.reaction", "sender": "@c:x", "content": { "m.relates_to": { "rel_type": "m.reference", "event_id": "$3", "key": "x" } } },
    { "type": "m.room.message", "sender": "@c:x", "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$3", "key": "x" } } }
  ]`)
	equal(t, ReactionsByTarget(raw), map[string][]Reaction{
		"$1": {{Key: "👍", Count: 2, Senders: []string{"@a:x", "@b:x"}}, {Key: "❤️", Count: 1, Senders: []string{"@b:x"}}},
		"$2": {{Key: "ok", Count: 1, Senders: []string{""}}},
	}, "reactions in the order they first appear, each sender once")
}

func TestUploadGuardAndFilenames(t *testing.T) {
	const state = "/opt/data/beeper-inbox/state"
	for _, path := range []string{
		"/opt/data/.env",
		"/opt/data/.ssh/id_ed25519",
		"/opt/data/beeper-inbox/state/pickle.db",
		"/opt/data/google_token.json",
		"/opt/data/config.yaml",
		"/opt/data/auth.json",
	} {
		if reason, refused := RefusedUploadReason(path, state); !refused || reason == "" {
			t.Fatalf("%s must be refused", path)
		}
	}
	for _, path := range []string{"/opt/data/artifacts/report.pdf", "/tmp/photo.jpg"} {
		if reason, refused := RefusedUploadReason(path, state); refused || reason != "" {
			t.Fatalf("%s is refused: %s", path, reason)
		}
	}
	equal(t, SafeFilename("../../etc/passwd", "x"), "passwd", "only the last path segment")
	equal(t, SafeFilename("..hidden", "x"), "hidden", "no leading dots")
	equal(t, SafeFilename("", "fallback"), "fallback", "nothing left")
}

// The reasons format.ts gives for the same paths.
func TestRefusedUploadReasons(t *testing.T) {
	const (
		private    = "it is inside beeper-inbox's private state"
		hidden     = "hidden files and folders (such as .env or .ssh) can't be sent"
		credential = "the filename looks like a credential or configuration file"
		tokens     = "it is inside Hermes's MCP token store"
	)
	for path, want := range map[string]string{
		"/opt/data/.env":                         hidden,
		"/opt/data/.ssh/id_ed25519":              hidden,
		"/opt/data/beeper-inbox/state/pickle.db": private,
		"/opt/data/beeper-inbox/state":           private,
		"/opt/data/beeper-inbox/state2/x.txt":    "",
		"/opt/data/google_token.json":            credential,
		"/opt/data/config.yaml":                  credential,
		"/opt/data/config.yml":                   credential,
		"/opt/data/auth.json":                    credential,
		"/opt/data/artifacts/report.pdf":         "",
		"/tmp/photo.jpg":                         "",
		"/opt/data/My-Private_Key.txt":           credential,
		"/opt/data/privatekey":                   credential,
		"/opt/data/server.PEM":                   credential,
		"/opt/data/pem.txt":                      "",
		"/opt/data/keys.txt":                     "",
		"/opt/data/a.key":                        credential,
		"/opt/data/cert.p12":                     credential,
		"/opt/data/mcp-tokens/a.txt":             tokens,
		"/opt/data/PASSWORDS.txt":                credential,
		"/opt/data/id_rsa.pub":                   credential,
		"/opt/data/x.env.txt":                    credential,
		"/opt/data/secretary/notes.txt":          "",
		"/":                                      "",
		"":                                       "",
	} {
		reason, refused := RefusedUploadReason(path, "/opt/data/beeper-inbox/state")
		equal(t, []any{reason, refused}, []any{want, want != ""}, "reason for "+path)
	}
}

// The names format.ts gives the same files.
func TestSafeFilenames(t *testing.T) {
	noBreakSpace := string(rune(0xA0))
	for _, sample := range [][2]string{
		{`a\b\c.txt`, "c.txt"},
		{`re<po>rt: "final"|?*.pdf`, "re_po_rt_ _final_.pdf"},
		{"tab\there" + string(rune(1)) + ".txt", "tab_here_.txt"},
		{"  spaced.txt  ", "spaced.txt"},
		{"...", "x"},
		{"dir/", "x"},
		{"a__b___c", "a_b_c"},
		{"a<>b", "a_b"},
		{"." + noBreakSpace + "x ", "x"},
		{strings.Repeat("x", 130) + ".pdf", strings.Repeat("x", 116) + ".pdf"},
		{strings.Repeat("👍", 61) + ".png", strings.Repeat("👍", 58) + ".png"},
		{"_", "_"},
		{" . ", "."},
	} {
		equal(t, SafeFilename(sample[0], "x"), sample[1], "safe name of "+sample[0])
	}
	// A name is cut to its last 120 UTF-16 units; a character that falls on the cut goes whole.
	equal(t, SafeFilename(strings.Repeat("👍", 61)+"x.png", "x"), strings.Repeat("👍", 57)+"x.png", "a cut inside a character")
}

func TestContentTypesAndMediaKinds(t *testing.T) {
	for filename, contentType := range map[string]string{
		"report.pdf":     "application/pdf",
		"PHOTO.JPG":      "image/jpeg",
		"a.b.Docx":       "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"noext":          "application/octet-stream",
		"pdf":            "application/pdf",
		"archive.tar.gz": "application/octet-stream",
		".env":           "application/octet-stream",
		"x.":             "application/octet-stream",
		"voice.m4a":      "audio/mp4",
	} {
		equal(t, ContentTypeFor(filename), contentType, "content type of "+filename)
	}
	equal(t, []string{
		MediaKind("image/png", "auto"), MediaKind("video/mp4", "auto"), MediaKind("audio/ogg", "auto"),
		MediaKind("application/pdf", "auto"), MediaKind("image/png", "file"),
	}, []string{"image", "video", "audio", "file", "file"}, "media kinds")
}

func TestFormatMessage(t *testing.T) {
	message := msg.Message{
		Attachments: []msg.Attachment{
			{Kind: "image", Filename: ptr("photo.jpg"), ContentType: ptr("image/jpeg"), Size: ptr(int64(9)), EncryptedFile: &msg.EncryptedFile{URL: "mxc://beeper.com/photo"}, ContentURI: ptr("mxc://beeper.com/ignored")},
			{Kind: "file", ContentURI: ptr("mxc://beeper.com/plain"), Size: ptr(int64(0)), Filename: ptr("")},
			{Kind: "audio"},
		},
		Edited:      true,
		Encrypted:   true,
		EventID:     "$1",
		HTML:        ptr("<b>hello</b> world"),
		Kind:        "message",
		MessageType: "m.image",
		ReplyTo:     "$0",
		RoomID:      "!r:x",
		Sender:      msg.Sender{IsMe: true, UserID: "@me:x"},
		Text:        "hello world",
		ThreadRoot:  "$root",
		Timestamp:   ptr(int64(1795000000123)),
		Type:        "m.room.message",
	}
	full := FormatMessage(message, Options{MaxText: 100, SenderName: "Leon", IncludeHTML: true})
	equal(t, show(full),
		`{"event_id":"$1","room_id":"!r:x","sender":"@me:x","is_me":true,"timestamp":"2026-11-18T11:06:40.123Z","ts":1795000000123,"type":"m.image","text":"hello world","edited":true,"encrypted":true,"attachments":[`+
			`{"index":0,"kind":"image","filename":"photo.jpg","content_type":"image/jpeg","size":9,"encrypted":true,"mxc":"mxc://beeper.com/photo"},`+
			`{"index":1,"kind":"file","filename":"","content_type":null,"size":0,"encrypted":false,"mxc":"mxc://beeper.com/plain"},`+
			`{"index":2,"kind":"audio","filename":null,"content_type":null,"size":null,"encrypted":false,"mxc":null}`+
			`],"sender_name":"Leon","html":"<b>hello</b> world","reply_to":"$0","thread_root":"$root"}`,
		"a message with everything, as the tools return it")

	cut := FormatMessage(message, Options{MaxText: 5, IncludeHTML: true})
	equal(t, []any{cut.Text, cut.TextTruncated, cut.HTML, cut.SenderName}, []any{"hello…", true, "<b>he", ""}, "long text is cut and marked")
	equal(t, FormatMessage(message, Options{MaxText: 11}).TextTruncated, false, "text of exactly the limit is whole")
	equal(t, FormatMessage(message, Options{MaxText: 100}).HTML, "", "the formatted body only when asked for")

	equal(t, show(FormatMessage(msg.Message{EventID: "$2", RoomID: "!r:x", Sender: msg.Sender{UserID: "@a:x"}, MessageType: "m.text"}, Options{MaxText: 100})),
		`{"event_id":"$2","room_id":"!r:x","sender":"@a:x","is_me":false,"timestamp":null,"ts":null,"type":"m.text","text":"","edited":false,"encrypted":false,"attachments":[]}`,
		"a bare message")

	// Limits count UTF-16 units, as before: an emoji is two.
	emoji := msg.Message{Text: "ab👍cd"}
	equal(t, FormatMessage(emoji, Options{MaxText: 4}).Text, "ab👍…", "a cut after a character")
	equal(t, FormatMessage(emoji, Options{MaxText: 3}).Text, "ab…", "a cut inside a character leaves it out")
	equal(t, FormatMessage(emoji, Options{MaxText: 6}).Text, "ab👍cd", "the whole text")
	equal(t, ISOTime(0), "1970-01-01T00:00:00.000Z", "the start of time")
}
